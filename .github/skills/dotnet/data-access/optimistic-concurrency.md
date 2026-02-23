# Optimistic Concurrency
> Verified against: .NET 9 | C# 13 | EF Core 9.x | SQL Server
> Last reviewed: 2026-02-22

## The Law
Add a `rowversion` (or `xmin` on PostgreSQL) concurrency token to every entity that can be updated by multiple actors — and handle `DbUpdateConcurrencyException` explicitly at the service layer.

## Why This Kills You At Scale
Two users edit the same resource simultaneously — first save wins silently, second save overwrites without warning. At 100k users in a collaborative chat app, concurrent message edits, profile updates, and conversation renames silently lose data. The user who "lost" has no idea their change was discarded. This is called the lost update problem and it is guaranteed to occur in production once you have enough concurrent users.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;

// ✅ Correct: concurrency token on entity
public class Conversation
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;

    // SQL Server: rowversion — auto-incremented by DB on every UPDATE
    [Timestamp]
    public byte[] RowVersion { get; set; } = [];
}

// ✅ Correct: EF Core configuration
public class ConversationConfiguration : IEntityTypeConfiguration<Conversation>
{
    public void Configure(EntityTypeBuilder<Conversation> builder)
    {
        builder.Property(c => c.RowVersion)
            .IsRowVersion()         // Tells EF Core to include in WHERE clause on UPDATE
            .IsConcurrencyToken();  // Throws DbUpdateConcurrencyException if mismatch
    }
}

// ✅ Correct: service handles the exception explicitly
public async Task<ConversationDto> UpdateTitleAsync(
    Guid conversationId,
    string newTitle,
    byte[] clientRowVersion,   // Client sends back the RowVersion it received
    CancellationToken ct)
{
    var conversation = await _context.Conversations
        .FirstOrDefaultAsync(c => c.Id == conversationId, ct)
        ?? throw new NotFoundException($"Conversation {conversationId} not found");

    // Set the RowVersion EF Core will include in the WHERE clause
    // UPDATE Conversations SET Title = @title WHERE Id = @id AND RowVersion = @clientRowVersion
    _context.Entry(conversation).Property(c => c.RowVersion).OriginalValue = clientRowVersion;

    conversation.Title = newTitle;

    try
    {
        await _context.SaveChangesAsync(ct);
        return conversation.ToDto();
    }
    catch (DbUpdateConcurrencyException ex)
    {
        // Another user updated this record between our read and our save
        var entry = ex.Entries.Single();
        var dbValues = await entry.GetDatabaseValuesAsync(ct);

        if (dbValues is null)
            throw new NotFoundException("Conversation was deleted by another user");

        // Return current state — client decides what to do (merge, overwrite, show conflict)
        throw new ConflictException(
            "Conversation was modified by another user",
            currentTitle: dbValues.GetValue<string>(nameof(Conversation.Title)));
    }
}

// ✅ Correct: refresh token rotation — critical use of optimistic concurrency
public async Task<string> RotateRefreshTokenAsync(
    Guid userId,
    string incomingToken,
    CancellationToken ct)
{
    var session = await _context.UserSessions
        .FirstOrDefaultAsync(s => s.UserId == userId, ct)
        ?? throw new UnauthorizedException("Session not found");

    // If two requests arrive simultaneously with the same refresh token,
    // only one will succeed — the other gets DbUpdateConcurrencyException
    // This prevents refresh token replay attacks in race conditions
    var newToken = _tokenService.GenerateRefreshToken();
    session.RefreshTokenHash = await HashTokenAsync(newToken, ct);

    try
    {
        await _context.SaveChangesAsync(ct);
        return newToken;
    }
    catch (DbUpdateConcurrencyException)
    {
        // Second simultaneous request — token already rotated
        throw new UnauthorizedException("Token already used — please reauthenticate");
    }
}

// ❌ Wrong: no concurrency token — lost updates silently
public class UnsafeConversation
{
    public Guid Id { get; set; }
    public string Title { get; set; } = string.Empty;
    // No RowVersion — two users editing simultaneously = one loses silently
}
```

## The Trap

```csharp
// A senior developer adds RowVersion and handles DbUpdateConcurrencyException.
// Looks complete. Passes review. Ships.
// The trap: ExecuteUpdateAsync bypasses the concurrency check entirely.

public async Task UpdateTitleFastAsync(Guid id, string title, CancellationToken ct)
{
    // BUG: ExecuteUpdateAsync generates: UPDATE Conversations SET Title = @title WHERE Id = @id
    // It does NOT include the RowVersion in the WHERE clause
    // Two simultaneous updates both succeed — lost update problem is back
    await _context.Conversations
        .Where(c => c.Id == id)
        .ExecuteUpdateAsync(s => s.SetProperty(c => c.Title, title), ct);
}

// Fix: for bulk/ExecuteUpdateAsync scenarios, include the version in the WHERE clause manually
public async Task UpdateTitleWithVersionAsync(
    Guid id, string title, byte[] expectedVersion, CancellationToken ct)
{
    var rowsAffected = await _context.Conversations
        .Where(c => c.Id == id && c.RowVersion == expectedVersion) // Manual concurrency check
        .ExecuteUpdateAsync(s => s.SetProperty(c => c.Title, title), ct);

    if (rowsAffected == 0)
        throw new ConflictException("Conversation was modified — please refresh and retry");
}
```

## The Exception
Entities that are only ever written by a single actor (audit log entries, append-only event records, insert-only tables) do not need concurrency tokens — there is no concurrent write scenario. Also: if your architecture uses pessimistic locking via `SELECT ... WITH (UPDLOCK)` in Dapper for a specific critical section, optimistic concurrency on that entity is redundant. Use one or the other, not both.

## Before You Merge
- Does every entity that can be updated by multiple users or concurrent processes have a `[Timestamp]` / `IsRowVersion()` property?
- Is `DbUpdateConcurrencyException` caught and handled at the service layer — not swallowed silently?
- Do `ExecuteUpdateAsync` calls on concurrency-sensitive entities include the version in the `WHERE` clause?
- Does the API return the updated `RowVersion` to the client so it can be sent back on the next update?
- Is the conflict response a `409 Conflict` HTTP status — not a 500 or silent overwrite?
