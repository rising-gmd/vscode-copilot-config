# Guard Clauses
> Verified against: .NET 9 | C# 13
> Last reviewed: 2026-02-22

## The Law
Validate preconditions at method entry using early-return guard clauses — never nest validation inside `if/else` blocks that bury the happy path six levels of indentation deep.

## Why This Kills You At Scale
A method with nested validation — `if (user != null) { if (user.IsActive) { if (user.IsEmailVerified) { ... } } }` — buries the main logic and makes every reviewer scan through three levels to understand the outcome. At 100k users with a complex domain, a missed null check or inverted condition inside the nesting causes a NullReferenceException or incorrect business rule execution that passes code review because no one can read the logic clearly. Guard clauses make violations of preconditions structurally impossible to miss.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: guard clauses — fail fast, then proceed with confidence
public sealed class MessageService(
    IMessageRepository repo,
    ICurrentUserService currentUser,
    IConversationRepository convRepo)
{
    public async Task<MessageDto> SendAsync(
        SendMessageRequest request,
        CancellationToken ct)
    {
        // ✅ Guard 1: validate input — throw immediately, don't continue
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Content,
            nameof(request.Content));

        // ✅ Guard 2: business rule — length limit is a precondition
        if (request.Content.Length > 4000)
            throw new ValidationException(
                "MESSAGE_TOO_LONG",
                "Message content cannot exceed 4000 characters");

        // ✅ Guard 3: authorization — check before any DB writes
        var userId = currentUser.GetUserId();
        var isMember = await convRepo.IsUserMemberAsync(
            request.ConversationId, userId, ct);

        if (!isMember)
            throw new ForbiddenException(
                "Not a member of this conversation");

        // ✅ Happy path starts here — no indentation, no ambiguity
        var message = Message.Create(
            request.ConversationId,
            userId,
            request.Content);

        await repo.AddAsync(message, ct);
        await _unitOfWork.SaveChangesAsync(ct);

        return message.ToDto();
    }
}

// ✅ Correct: .NET 9 built-in guard methods — prefer these over manual checks
public static class GuardExtensions
{
    // Use built-ins where possible:
    // ArgumentNullException.ThrowIfNull(value)
    // ArgumentException.ThrowIfNullOrWhiteSpace(value)
    // ArgumentOutOfRangeException.ThrowIfLessThan(value, min)
    // ArgumentOutOfRangeException.ThrowIfGreaterThan(value, max)
    // ArgumentOutOfRangeException.ThrowIfNegative(value)
    // ArgumentOutOfRangeException.ThrowIfZero(value)

    // Domain-specific guard — wraps built-ins with meaningful error codes
    public static Guid RequireUserId(this Guid id, string paramName = "userId")
    {
        if (id == Guid.Empty)
            throw new ValidationException(
                "USER_ID_REQUIRED",
                $"{paramName} cannot be an empty GUID");
        return id;
    }

    public static string RequireContent(
        this string? content,
        int maxLength = 4000,
        string paramName = "content")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(content, paramName);

        if (content.Length > maxLength)
            throw new ValidationException(
                "CONTENT_TOO_LONG",
                $"{paramName} cannot exceed {maxLength} characters");

        return content.Trim();
    }
}

// ✅ Correct: guard in domain entity — fail at construction
public sealed class Message
{
    private Message() { }

    public static Message Create(
        Guid conversationId,
        Guid senderId,
        string content)
    {
        // Guards run before the object exists — invariants enforced at birth
        ArgumentOutOfRangeException.ThrowIfEqual(
            conversationId, Guid.Empty, nameof(conversationId));
        ArgumentOutOfRangeException.ThrowIfEqual(
            senderId, Guid.Empty, nameof(senderId));
        ArgumentException.ThrowIfNullOrWhiteSpace(content, nameof(content));

        if (content.Length > 4000)
            throw new DomainException("Message content cannot exceed 4000 characters");

        return new Message
        {
            Id = Guid.NewGuid(),
            ConversationId = conversationId,
            SenderId = senderId,
            Content = content.Trim(),
            SentAt = DateTime.UtcNow
        };
    }
}

// ❌ Wrong: nested if/else — happy path buried, easy to miss a case
public async Task<MessageDto> SendInsecureAsync(
    SendMessageRequest? request,
    CancellationToken ct)
{
    if (request != null)
    {
        if (!string.IsNullOrWhiteSpace(request.Content))
        {
            if (request.Content.Length <= 4000)
            {
                var userId = currentUser.GetUserId();
                var isMember = await convRepo.IsUserMemberAsync(
                    request.ConversationId, userId, ct);

                if (isMember)
                {
                    // Happy path buried under 5 levels of nesting
                    var message = Message.Create(
                        request.ConversationId, userId, request.Content);
                    // ... continue
                }
                // Silently returns null if not a member — caller must check
            }
        }
    }
    return null!; // Caller has no idea when this returns null
}
```

## The Trap

```csharp
// A senior developer correctly applies guard clauses throughout.
// Code is flat and readable. Ships.
// The trap: async guard clauses before CancellationToken check create wasted work.

public async Task ProcessAsync(Guid id, CancellationToken ct)
{
    // ✅ Cheap synchronous guards first — no async, no cancellation check needed
    ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty, nameof(id));

    // BUG: expensive async guard before checking if request is already cancelled
    var user = await _repo.GetByIdAsync(id, ct); // DB round trip

    // Only now check cancellation — but ct was already passed to the DB call
    ct.ThrowIfCancellationRequested(); // This line is useless — DB call already propagated ct

    if (user is null)
        throw new NotFoundException($"User {id} not found");

    // ... continue
}

// The correct order:
public async Task ProcessFixedAsync(Guid id, CancellationToken ct)
{
    // 1. Cheap synchronous guards — free
    ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty, nameof(id));

    // 2. Cancellation check before any async work — prevent wasted DB call
    ct.ThrowIfCancellationRequested();

    // 3. Expensive async guards — now we know we should proceed
    var user = await _repo.GetByIdAsync(id, ct)
        ?? throw new NotFoundException($"User {id} not found");

    // 4. Business rule guards — after loading needed data
    if (!user.IsActive)
        throw new DomainException("User account is not active");

    // 5. Happy path
}

// Order: synchronous → cancellation → async → business rules → happy path
```

## The Exception
Domain entity constructors that enforce invariants within the same assembly can use direct `if/throw` patterns rather than guard clause methods — they are so close to the object creation that readability is not harmed. The guard clause pattern is most valuable in service methods and application orchestration code where the validation logic and the business logic are visually far apart and the reader must understand both to review the method.

## Before You Merge
- Does every public method validate its parameters in the first lines — before any business logic or async operations?
- Is `ct.ThrowIfCancellationRequested()` called before the first async operation — preventing wasted work on already-cancelled requests?
- Are built-in .NET 9 guard methods used (`ArgumentNullException.ThrowIfNull`, `ArgumentException.ThrowIfNullOrWhiteSpace`) before custom guards?
- Is the happy path code at the lowest indentation level in every method — not buried inside `if` blocks?
- Do guard clauses throw typed domain exceptions (`ValidationException`, `ForbiddenException`) — not generic `ArgumentException` for business rule violations?
