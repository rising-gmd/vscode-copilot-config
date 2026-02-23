# Unit of Work
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Call `SaveChangesAsync()` exactly once per logical business operation — from the service layer, after all repository operations are complete — never from inside repositories or constructors.

## Why This Kills You At Scale
Two repository methods each calling `SaveChangesAsync()` inside a logical operation that should be atomic — if the second repository call fails, the first has already committed. At 100k users creating conversations, a crash between the first and second `SaveChanges` produces conversations with no participants, messages with no conversation, or sessions with no user — silent data corruption that surfaces as mysterious 500 errors weeks later.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;
using System.Data;

// ✅ Correct: IUnitOfWork interface in Application layer
public interface IUnitOfWork
{
    Task<int> SaveChangesAsync(CancellationToken ct = default);
    Task ExecuteInTransactionAsync(Func<Task> operation, CancellationToken ct = default);
}

// ✅ Correct: implementation wraps AppDbContext
public sealed class UnitOfWork(AppDbContext context) : IUnitOfWork
{
    public Task<int> SaveChangesAsync(CancellationToken ct = default)
        => context.SaveChangesAsync(ct);

    public async Task ExecuteInTransactionAsync(Func<Task> operation, CancellationToken ct = default)
    {
        // ✅ Use EF Core's execution strategy — handles transient SQL errors with retry
        var strategy = context.Database.CreateExecutionStrategy();

        await strategy.ExecuteAsync(async () =>
        {
            await using var transaction = await context.Database.BeginTransactionAsync(ct);
            try
            {
                await operation();
                await context.SaveChangesAsync(ct);
                await transaction.CommitAsync(ct);
            }
            catch
            {
                await transaction.RollbackAsync(ct);
                throw;
            }
        });
    }
}

// ✅ Correct: service layer owns SaveChanges — all repository ops then one save
public sealed class ConversationService(
    IConversationRepository conversationRepo,
    IUserRepository userRepo,
    IRealTimeNotifier notifier,
    IUnitOfWork unitOfWork,
    ICurrentUserService currentUser)
{
    public async Task<ConversationDto> GetOrCreateDirectAsync(
        Guid otherUserId,
        CancellationToken ct)
    {
        var currentUserId = currentUser.GetUserId();

        var otherUser = await userRepo.GetByIdAsync(otherUserId, ct)
            ?? throw new NotFoundException("User not found");

        // Repository adds to context — no SaveChanges yet
        var conversation = await conversationRepo.GetOrCreateDirectAsync(
            currentUserId, otherUserId, ct);

        // Single SaveChanges — atomic, all or nothing
        await unitOfWork.SaveChangesAsync(ct);

        var dto = conversation.ToDto(otherUser);

        // Notify AFTER commit — do not notify if save failed
        await notifier.TryNotifyConversationCreatedAsync(otherUserId, dto);

        return dto;
    }
}

// ✅ Correct: explicit transaction for multi-step atomic operation
public async Task TransferConversationAsync(
    Guid messageId,
    Guid fromConvId,
    Guid toConvId,
    CancellationToken ct)
{
    await unitOfWork.ExecuteInTransactionAsync(async () =>
    {
        await messageRepo.MoveToConversationAsync(messageId, toConvId, ct);
        await conversationRepo.UpdateLastActivityAsync(fromConvId, ct);
        await conversationRepo.UpdateLastActivityAsync(toConvId, ct);
        // SaveChanges is called by ExecuteInTransactionAsync — not here
    }, ct);
}

// ❌ Wrong: SaveChanges in repository — breaks atomicity
public class BrokenRepository(AppDbContext context)
{
    public async Task AddParticipantAsync(ConversationParticipant p, CancellationToken ct)
    {
        await context.ConversationParticipants.AddAsync(p, ct);
        await context.SaveChangesAsync(ct); // Commits immediately — cannot be rolled back
    }
}

// ❌ Wrong: multiple SaveChanges in service — partial failure possible
public async Task CreateConversationInsecureAsync(Guid userId1, Guid userId2, CancellationToken ct)
{
    var conv = new Conversation();
    await conversationRepo.AddAsync(conv, ct);
    await unitOfWork.SaveChangesAsync(ct); // First commit

    var participant1 = new ConversationParticipant { ConversationId = conv.Id, UserId = userId1 };
    await participantRepo.AddAsync(participant1, ct);
    await unitOfWork.SaveChangesAsync(ct); // Second commit — if this fails, conv exists with no participants
}
```

## The Trap

```csharp
// A senior developer correctly uses IUnitOfWork with one SaveChanges.
// Works perfectly under normal load.
// The trap: EF Core's execution strategy and explicit transactions conflict.

public async Task DoSomethingAsync(CancellationToken ct)
{
    // EF Core's retry execution strategy cannot be used inside
    // an explicitly-started transaction — it throws:
    // InvalidOperationException: The configured execution strategy
    // does not support user-initiated transactions.

    await using var transaction = await context.Database.BeginTransactionAsync(ct);
    // ^ This works fine with no retry strategy configured.
    // ^ With EnableRetryOnFailure(), this throws immediately.

    // Fix: always wrap explicit transactions inside CreateExecutionStrategy()
    // as shown in ExecuteInTransactionAsync above.
    // NEVER start transactions directly — always go through the strategy.
}

// The symptom: works in development (no retry strategy), fails in production
// (retry strategy enabled for Azure SQL). Discovered when first transient error hits.
```

## The Exception
Read-only operations that use `AsNoTracking()` and never call `SaveChanges` do not need the Unit of Work — they bypass EF Core's change tracker entirely and there is nothing to coordinate. The Unit of Work pattern exists to coordinate writes. A query-only service that never mutates state has no use for `IUnitOfWork` and should not inject it.

## Before You Merge
- Is `SaveChangesAsync()` called exactly once per business operation — from the service layer?
- Are all repository methods free of any `SaveChanges` call?
- Do explicit transactions use `CreateExecutionStrategy()` wrapping — not direct `BeginTransactionAsync()`?
- Are post-commit side effects (notifications, emails, events) triggered after `SaveChangesAsync()` succeeds — not before?
- Does `ExecuteInTransactionAsync` roll back on any exception — not just specific types?
