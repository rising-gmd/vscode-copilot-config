# Domain-Driven Design
> Verified against: .NET 9 | C# 13
> Last reviewed: 2026-02-22

## The Law
Model your domain in code that speaks the language of the business — entities enforce their own invariants, value objects are immutable, and aggregates are the only entry point for state changes.

## Why This Kills You At Scale
An anemic domain model — entities that are just property bags with no behaviour — scatters business logic across services, validators, and controllers. At 100k users, "can this user send a message in this conversation" is a business rule that appears in 6 different places: the REST API, the SignalR hub, a Hangfire job, an admin endpoint, an integration test, and a background sync. Each implementation drifts subtly. One is missing an `IsDeleted` check. Six months later a deleted user's account can still send messages through one of those paths.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: Value Object — immutable, equality by value, self-validating
public sealed record MessageContent
{
    public string Value { get; }

    // Factory method — the only way to create a valid MessageContent
    public static MessageContent Create(string? raw)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(raw, nameof(raw));

        var trimmed = raw.Trim();

        if (trimmed.Length > 4000)
            throw new DomainException(
                "MESSAGE_TOO_LONG",
                "Message content cannot exceed 4000 characters");

        return new MessageContent(trimmed);
    }

    private MessageContent(string value) => Value = value;

    // Value object equality — two MessageContents with same text are equal
    public override string ToString() => Value;
}

// ✅ Correct: Entity — has identity, enforces invariants via methods
public sealed class Conversation : AggregateRoot
{
    public Guid Id { get; private set; }
    public bool IsGroup { get; private set; }
    public bool IsDeleted { get; private set; }
    public DateTime LastActivity { get; private set; }

    private readonly List<ConversationParticipant> _participants = [];
    public IReadOnlyList<ConversationParticipant> Participants
        => _participants.AsReadOnly();

    private readonly List<Message> _messages = [];
    public IReadOnlyList<Message> Messages => _messages.AsReadOnly();

    // ✅ Factory method — invariants enforced at creation
    public static Conversation CreateDirect(Guid userId1, Guid userId2)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(userId1, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(userId2, Guid.Empty);

        if (userId1 == userId2)
            throw new DomainException(
                "SAME_USER_CONVERSATION",
                "Cannot create a conversation with yourself");

        var conversation = new Conversation
        {
            Id = Guid.NewGuid(),
            IsGroup = false,
            LastActivity = DateTime.UtcNow
        };

        conversation._participants.Add(
            ConversationParticipant.Create(conversation.Id, userId1));
        conversation._participants.Add(
            ConversationParticipant.Create(conversation.Id, userId2));

        conversation.RaiseDomainEvent(
            new ConversationCreatedEvent(conversation.Id, userId1, [userId1, userId2]));

        return conversation;
    }

    // ✅ Behaviour method — business rule lives here, not scattered in services
    public Message SendMessage(Guid senderId, MessageContent content)
    {
        EnsureNotDeleted();
        EnsureIsMember(senderId);

        var message = Message.Create(Id, senderId, content);
        _messages.Add(message);
        LastActivity = DateTime.UtcNow;

        RaiseDomainEvent(new MessageSentEvent(
            message.Id, Id, senderId, content.Value, message.SentAt));

        return message;
    }

    public void AddParticipant(Guid userId, Guid addedByUserId)
    {
        EnsureNotDeleted();
        EnsureIsMember(addedByUserId);

        if (!IsGroup)
            throw new DomainException(
                "CANNOT_ADD_TO_DIRECT",
                "Cannot add participants to a direct conversation");

        if (_participants.Any(p => p.UserId == userId))
            throw new DomainException(
                "ALREADY_MEMBER",
                "User is already a member of this conversation");

        _participants.Add(ConversationParticipant.Create(Id, userId));
    }

    public void Delete(Guid deletedByUserId)
    {
        EnsureNotDeleted();
        EnsureIsMember(deletedByUserId);

        IsDeleted = true;
        RaiseDomainEvent(new ConversationDeletedEvent(Id, deletedByUserId));
    }

    // ✅ Private invariant checks — reused across behaviour methods
    private void EnsureNotDeleted()
    {
        if (IsDeleted)
            throw new DomainException("CONVERSATION_DELETED", "Conversation has been deleted");
    }

    private void EnsureIsMember(Guid userId)
    {
        if (!_participants.Any(p => p.UserId == userId))
            throw new ForbiddenException("User is not a member of this conversation");
    }
}

// ✅ Correct: application service calls domain methods — no business logic in service
public sealed class ConversationService(
    IConversationRepository repo,
    IUnitOfWork unitOfWork,
    ICurrentUserService currentUser)
{
    public async Task<MessageDto> SendMessageAsync(
        Guid conversationId,
        string rawContent,
        CancellationToken ct)
    {
        var userId = currentUser.GetUserId();

        // Load aggregate — must load with all children needed for the operation
        var conversation = await repo.GetWithParticipantsAsync(conversationId, ct)
            ?? throw new NotFoundException($"Conversation {conversationId} not found");

        // Domain method enforces ALL business rules — service just orchestrates
        var content = MessageContent.Create(rawContent);
        var message = conversation.SendMessage(userId, content);

        await unitOfWork.SaveChangesAsync(ct);
        return message.ToDto();
    }
}

// ❌ Wrong: anemic domain model — entity is a property bag, logic in service
public sealed class AnemicConversation
{
    public Guid Id { get; set; }
    public bool IsDeleted { get; set; }
    public List<ConversationParticipant> Participants { get; set; } = [];
}

public sealed class AnemicConversationService
{
    public async Task SendMessageAsync(Guid convId, Guid userId, string content)
    {
        var conv = await _repo.GetByIdAsync(convId);
        // Business rules scattered in service — duplicated wherever else they're needed
        if (conv.IsDeleted) throw new Exception("Deleted");
        if (!conv.Participants.Any(p => p.UserId == userId)) throw new Exception("Not member");
        if (content.Length > 4000) throw new Exception("Too long");
        // ... more rules copied to SignalR hub, admin endpoint, etc.
    }
}
```

## The Trap

```csharp
// A senior developer builds a rich domain model with entities enforcing invariants.
// All business rules live in the domain. Services are thin. Ships.
// The trap: EF Core cannot map private setters and private list fields by default.

// EF Core requires:
// 1. Private fields for collections: _participants (not public List<>)
// 2. Private setters for scalar properties
// 3. Protected parameterless constructor for EF Core to instantiate the entity

public sealed class Conversation : AggregateRoot
{
    // ✅ EF Core needs this — protected so it can call it, private so domain cannot
    private Conversation() { }

    // ✅ EF Core maps _participants via HasField("_participants") in Fluent API
    private readonly List<ConversationParticipant> _participants = [];

    public IReadOnlyList<ConversationParticipant> Participants
        => _participants.AsReadOnly();
}

// ✅ EF Core Fluent configuration for private fields
public sealed class ConversationConfiguration : IEntityTypeConfiguration<Conversation>
{
    public void Configure(EntityTypeBuilder<Conversation> builder)
    {
        builder.HasKey(c => c.Id);

        // Map the private backing field — EF Core populates _participants directly
        builder.HasMany<ConversationParticipant>("_participants")
            .WithOne()
            .HasForeignKey(p => p.ConversationId);

        // Private setter on scalar properties — EF Core uses reflection to set them
        builder.Property(c => c.IsDeleted).HasColumnName("IsDeleted");
        builder.Property(c => c.LastActivity).HasColumnName("LastActivity");
    }
}

// Without this configuration, EF Core either:
// (a) ignores _participants entirely — loads empty collection always
// (b) throws mapping exception at startup
// Both failures are discovered only in integration tests, not unit tests.
```

## The Exception
Simple CRUD resources with no business invariants — user preferences, display settings, notification toggles — do not need a rich domain model. An entity that is literally just a key-value store of user preferences has no behaviour to encapsulate. Apply DDD where complexity lives: the conversation model, message threading, participant management, permission rules. Apply simple data mapping where the domain is inherently simple. The architecture should serve the complexity of the domain, not impose complexity on it.

## Before You Merge
- Do domain entities enforce all their invariants through behaviour methods — no public setters on protected state?
- Are value objects immutable records with factory methods that validate on creation?
- Does EF Core configuration use `HasField("_fieldName")` to map private backing fields?
- Does every entity have a `private` or `protected` parameterless constructor for EF Core — distinct from the factory method?
- Is the application service calling domain methods — not reimplementing business rules in the service layer?
