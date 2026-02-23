# Result Pattern
> Verified against: .NET 9 | C# 13
> Last reviewed: 2026-02-22

## The Law
Return `Result<T>` from application service methods that have expected failure states — reserve exceptions for unexpected failures and programming errors, not business rule violations.

## Why This Kills You At Scale
Using exceptions for business flow control (throwing `InvalidCredentialsException` when a user enters a wrong password) is 10-100x slower than returning a result value — exceptions unwind the call stack, capture stack traces, and trigger GC pressure. At 100k users where login attempts include bots and typos, 10% of login calls might be failed attempts. If each failed attempt throws an exception, you pay exception overhead for 10,000 legitimate business events per minute.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: Result type — discriminated union over success or failure
public sealed class Result<T>
{
    private readonly T? _value;
    private readonly Error? _error;

    private Result(T value) => (_value, IsSuccess) = (value, true);
    private Result(Error error) => (_error, IsSuccess) = (error, false);

    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;

    public T Value => IsSuccess
        ? _value!
        : throw new InvalidOperationException("Cannot access Value on a failed result");

    public Error Error => IsFailure
        ? _error!
        : throw new InvalidOperationException("Cannot access Error on a successful result");

    public static Result<T> Success(T value) => new(value);
    public static Result<T> Failure(Error error) => new(error);

    // ✅ Pattern matching support
    public TOut Match<TOut>(Func<T, TOut> onSuccess, Func<Error, TOut> onFailure)
        => IsSuccess ? onSuccess(_value!) : onFailure(_error!);
}

// Non-generic result for void operations
public sealed class Result
{
    private readonly Error? _error;
    private Result() => IsSuccess = true;
    private Result(Error error) => (_error, IsSuccess) = (error, false);

    public bool IsSuccess { get; }
    public bool IsFailure => !IsSuccess;
    public Error Error => IsFailure ? _error! : throw new InvalidOperationException();

    public static Result Success() => new();
    public static Result Failure(Error error) => new(error);
}

// ✅ Correct: Error type — structured, not just a string
public sealed record Error(string Code, string Message, ErrorType Type = ErrorType.Business);

public enum ErrorType { Business, NotFound, Unauthorized, Conflict, Validation }

// ✅ Correct: static error definitions — discoverable, consistent
public static class ConversationErrors
{
    public static readonly Error NotFound =
        new("CONVERSATION_NOT_FOUND", "Conversation not found", ErrorType.NotFound);
    public static readonly Error NotMember =
        new("NOT_CONVERSATION_MEMBER", "You are not a member of this conversation", ErrorType.Unauthorized);
    public static readonly Error TitleTooLong =
        new("TITLE_TOO_LONG", "Title cannot exceed 100 characters", ErrorType.Validation);
}

// ✅ Correct: application service returns Result
public sealed class ConversationService
{
    public async Task<Result<ConversationDto>> UpdateTitleAsync(
        Guid id, string newTitle, CancellationToken ct)
    {
        if (newTitle.Length > 100)
            return Result<ConversationDto>.Failure(ConversationErrors.TitleTooLong);

        var conversation = await _repo.GetByIdAsync(id, ct);
        if (conversation is null)
            return Result<ConversationDto>.Failure(ConversationErrors.NotFound);

        if (conversation.UserId != _currentUser.GetUserId())
            return Result<ConversationDto>.Failure(ConversationErrors.NotMember);

        conversation.UpdateTitle(newTitle);
        await _unitOfWork.SaveChangesAsync(ct);
        return Result<ConversationDto>.Success(conversation.ToDto());
    }
}

// ✅ Correct: controller maps Result to HTTP response
[HttpPatch("{id:guid}/title")]
public async Task<IActionResult> UpdateTitle(Guid id, [FromBody] UpdateTitleRequest request, CancellationToken ct)
{
    var result = await _conversationService.UpdateTitleAsync(id, request.Title, ct);

    return result.Match<IActionResult>(
        onSuccess: dto => Ok(dto),
        onFailure: error => error.Type switch
        {
            ErrorType.NotFound => NotFound(ToProblemDetails(error)),
            ErrorType.Unauthorized => Forbid(),
            ErrorType.Validation => BadRequest(ToProblemDetails(error)),
            _ => BadRequest(ToProblemDetails(error))
        });
}

// ❌ Wrong: exception for business flow
public async Task<ConversationDto> UpdateTitleException(Guid id, string title, CancellationToken ct)
{
    var conversation = await _repo.GetByIdAsync(id, ct)
        ?? throw new NotFoundException("Not found"); // Exception for expected flow

    if (conversation.UserId != _currentUser.GetUserId())
        throw new ForbiddenException("Not member"); // Exception for expected flow

    // Both of these cases are expected — they happen hundreds of times per day
    // They are not "exceptional" circumstances
}
```

## The Trap

```csharp
// A senior developer adopts the Result pattern.
// Services return Results. Controllers map them. Ships.
// The trap: Railway-oriented programming chains get out of hand.

// The first sign: deeply nested Match calls
public async Task<Result<MessageDto>> SendMessageAsync(
    SendMessageRequest request, CancellationToken ct)
{
    var conversationResult = await GetConversationAsync(request.ConversationId, ct);
    return conversationResult.Match(
        onSuccess: conversation =>
        {
            var memberResult = CheckMembership(conversation, request.UserId);
            return memberResult.Match(
                onSuccess: _ =>
                {
                    var validationResult = ValidateContent(request.Content);
                    return validationResult.Match(
                        onSuccess: _ => CreateMessageAsync(conversation, request, ct).GetAwaiter().GetResult(),
                        // Nested GetAwaiter().GetResult() — deadlock waiting to happen
                        onFailure: error => Task.FromResult(Result<MessageDto>.Failure(error)).GetAwaiter().GetResult()
                    );
                },
                onFailure: error => Result<MessageDto>.Failure(error)
            );
        },
        onFailure: error => Result<MessageDto>.Failure(error)
    );
}

// Fix: use early return pattern instead of nested Match
public async Task<Result<MessageDto>> SendMessageSafeAsync(
    SendMessageRequest request, CancellationToken ct)
{
    var conversationResult = await GetConversationAsync(request.ConversationId, ct);
    if (conversationResult.IsFailure)
        return Result<MessageDto>.Failure(conversationResult.Error);

    var memberResult = CheckMembership(conversationResult.Value, request.UserId);
    if (memberResult.IsFailure)
        return Result<MessageDto>.Failure(memberResult.Error);

    var validationResult = ValidateContent(request.Content);
    if (validationResult.IsFailure)
        return Result<MessageDto>.Failure(validationResult.Error);

    return await CreateMessageAsync(conversationResult.Value, request, ct);
}
```

## The Exception
Truly exceptional scenarios — DB connection failure, null reference from a corrupted state, infrastructure errors — should still use exceptions. The Result pattern is for expected business outcomes: user not found, validation failure, access denied, resource locked. If the code path represents something that "should never happen if the code is correct," use an exception. If it represents something that "happens routinely during normal operation," use Result.

## Before You Merge
- Do application service methods that can fail in expected ways return `Result<T>` — not throw exceptions for business flow?
- Are error codes defined as static fields in a domain-specific error class — not as inline strings?
- Does the controller map `ErrorType` to HTTP status codes — not catch exceptions to determine status?
- Are `Result` chains using early return pattern — not nested `Match` calls that create callback pyramids?
- Are infrastructure exceptions (DB failures, network errors) still propagating as exceptions — not wrapped in Result?
