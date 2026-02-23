# Defensive Programming
> Verified against: .NET 9 | C# 13
> Last reviewed: 2026-02-22

## The Law
Assume every external input, dependency response, and system boundary can fail or return unexpected values — validate explicitly at every crossing, and design internal code to be impossible to misuse.

## Why This Kills You At Scale
A `ToDto()` mapping method that calls `user.Profile.AvatarUrl` without null checking works in development where every test user has a profile. In production at 100k users, 3% registered before profile was a required field — null reference exceptions every time their data is displayed. The failure is intermittent, hard to reproduce, and affects a population the development team did not know existed. Defensive programming at system boundaries catches these populations before they cause incidents.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: nullable reference types enabled — compiler enforces defensive checks
// Enable globally in .csproj:
// <Nullable>enable</Nullable>
// <WarningsAsErrors>nullable</WarningsAsErrors> — treat nullable warnings as errors in CI

// ✅ Correct: defensive DTO mapping — handle missing optional data gracefully
public static class MessageMappingExtensions
{
    public static MessageDto ToDto(this Message message)
    {
        ArgumentNullException.ThrowIfNull(message);

        return new MessageDto(
            Id: message.Id,
            Content: message.Content,
            SenderId: message.SenderId,
            // ✅ Defensive: sender may not be loaded (lazy or no include)
            SenderUsername: message.Sender?.Username ?? "[Unknown]",
            // ✅ Defensive: profile picture may not exist for old accounts
            SenderProfilePicture: message.Sender?.Profile?.AvatarUrl,
            SentAt: message.SentAt,
            // ✅ Defensive: enum values may have been added since this entity was persisted
            Status: Enum.IsDefined(message.Status) ? message.Status : DeliveryStatus.Saved
        );
    }
}

// ✅ Correct: defensive deserialization — external APIs return unexpected shapes
public sealed class ExternalWebhookHandler
{
    public async Task HandleAsync(string rawPayload, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(rawPayload))
        {
            _logger.LogWarning("Received empty webhook payload — ignoring");
            return;
        }

        WebhookPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<WebhookPayload>(rawPayload);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to deserialize webhook payload: {Payload}",
                rawPayload[..Math.Min(rawPayload.Length, 200)]); // Truncate for safety
            return; // Do not rethrow — bad payload is not our fault, do not 500
        }

        if (payload is null)
        {
            _logger.LogWarning("Webhook payload deserialized to null");
            return;
        }

        // ✅ Validate required fields explicitly — don't trust external input
        if (string.IsNullOrWhiteSpace(payload.EventType))
        {
            _logger.LogWarning("Webhook missing EventType — ignoring");
            return;
        }

        await ProcessAsync(payload, ct);
    }
}

// ✅ Correct: defensive collection operations — prevent InvalidOperationException
public sealed class ConversationService
{
    public async Task<MessageDto?> GetLastMessageAsync(
        Guid conversationId,
        CancellationToken ct)
    {
        var messages = await _repo.GetByConversationAsync(conversationId, ct);

        // ✅ Use FirstOrDefault/LastOrDefault — never First/Last on potentially empty collections
        return messages
            .OrderByDescending(m => m.SentAt)
            .FirstOrDefault()  // Null if no messages — not InvalidOperationException
            ?.ToDto();
    }
}

// ✅ Correct: Enum safety — persisted enums can be stale after additions
public static class EnumExtensions
{
    public static TEnum ParseSafely<TEnum>(
        int value,
        TEnum defaultValue)
        where TEnum : struct, Enum
    {
        return Enum.IsDefined(typeof(TEnum), value)
            ? (TEnum)(object)value
            : defaultValue;
    }
}

// ✅ Correct: defensive string truncation for logging — never log unbounded user input
public static class LoggingExtensions
{
    public static string Truncate(this string? value, int maxLength = 200)
    {
        if (value is null) return "[null]";
        if (value.Length <= maxLength) return value;
        return value[..maxLength] + $"...[truncated {value.Length - maxLength} chars]";
    }
}

// ❌ Wrong: trusting navigation properties are loaded
public MessageDto ToDtoInsecure(Message message)
{
    return new MessageDto(
        SenderUsername: message.Sender.Username, // NullReferenceException if Sender not loaded
        SenderAvatar: message.Sender.Profile.AvatarUrl // NullReferenceException at 3% of users
    );
}

// ❌ Wrong: First() on queryable — throws if empty
public async Task<MessageDto> GetLastInsecureAsync(Guid convId, CancellationToken ct)
{
    return await _context.Messages
        .Where(m => m.ConversationId == convId)
        .OrderByDescending(m => m.SentAt)
        .Select(m => m.ToDto())
        .First() // InvalidOperationException if no messages
        .AsTask();
}
```

## The Trap

```csharp
// A senior developer correctly enables #nullable and handles null navigation properties.
// All mappings are defensive. Ships.
// The trap: #nullable enable is compile-time only — it does not prevent runtime nulls
// from data that was persisted before nullable was enabled, or from raw SQL/Dapper results.

// Scenario: Users table has 50,000 rows with NULL in the new "Username" column
// because the column was added after the initial data migration ran.
// EF Core with #nullable maps it to string? Username.
// Developer marks Username as non-nullable in the domain entity: string Username
// With #nullable enable, this compiles fine — EF Core bypasses the type system
// and sets Username = null at runtime, because the DB column contains null.

// The result: NullReferenceException at runtime even with #nullable enable.

public sealed class User
{
    // #nullable enable tells the compiler Username is non-nullable
    // EF Core ignores this and sets it to null if the DB column is null
    public string Username { get; private set; } = string.Empty; // Not actually guaranteed

    public string GetDisplayName()
        => Username.ToUpperInvariant(); // NullReferenceException for old accounts
}

// Fix 1: add NOT NULL constraint with a default value in migration
// migrationBuilder.AlterColumn<string>("Username", "Users", nullable: false, defaultValue: "");

// Fix 2: validate non-nullable data at the repository boundary
public async Task<User?> GetByIdAsync(Guid id, CancellationToken ct)
{
    var user = await _context.Users.FindAsync(id, ct);

    // Defensive: validate invariants after loading from DB
    if (user is not null && string.IsNullOrWhiteSpace(user.Username))
    {
        _logger.LogWarning("User {UserId} has null/empty Username — data inconsistency", id);
        // Either throw, repair, or return null depending on business context
    }

    return user;
}
```

## The Exception
Internal code — private methods called only from within the same class, operating on data already validated at the class boundary — does not need defensive null checks at every line. Defensive programming applies at system boundaries: public APIs, data deserialization, database reads, external service responses, and method signatures visible to other assemblies. Internal plumbing that operates on data already validated is allowed to assume invariants hold — this is where `!` (null-forgiving operator) is occasionally justified.

## Before You Merge
- Is `<Nullable>enable</Nullable>` set in every project's `.csproj` — and nullable warnings treated as errors in CI?
- Do all DTO mapping methods use `?.` for optional navigation properties — never assuming eager loading happened?
- Are all `First()` and `Last()` calls on collections replaced with `FirstOrDefault()` and `LastOrDefault()` with null handling?
- Are enum values from the database validated with `Enum.IsDefined()` before use — to handle values added after persistence?
- Are user-supplied values logged with `.Truncate(200)` — preventing multi-megabyte strings from filling log storage?
