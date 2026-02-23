# Specification Pattern
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Encapsulate query criteria as named, composable Specification objects — never scatter identical `Where()` predicates across multiple repository methods or duplicate filtering logic between endpoints.

## Why This Kills You At Scale
A business rule — "active users only means `IsActive = true AND IsEmailVerified = true AND IsDeleted = false`" — implemented as three separate `.Where()` calls in 15 repository methods means a rule change requires finding and updating all 15. At 100k users, when the definition of "active" changes (adding `LastLoginAt > 90 days`), you find 12 of the 15 and miss 3. Those 3 serve stale data for weeks before a support ticket surfaces the inconsistency.

## The Pattern

```csharp
#nullable enable
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;

// ✅ Correct: generic specification base
public abstract class Specification<T>
{
    public abstract Expression<Func<T, bool>> Criteria { get; }

    // ✅ Composable — combine specs with AND/OR without modifying originals
    public Specification<T> And(Specification<T> other)
        => new AndSpecification<T>(this, other);

    public Specification<T> Or(Specification<T> other)
        => new OrSpecification<T>(this, other);

    public bool IsSatisfiedBy(T entity)
        => Criteria.Compile()(entity);
}

internal sealed class AndSpecification<T>(
    Specification<T> left,
    Specification<T> right) : Specification<T>
{
    public override Expression<Func<T, bool>> Criteria
    {
        get
        {
            var param = Expression.Parameter(typeof(T));
            var body = Expression.AndAlso(
                Expression.Invoke(left.Criteria, param),
                Expression.Invoke(right.Criteria, param));
            return Expression.Lambda<Func<T, bool>>(body, param);
        }
    }
}

internal sealed class OrSpecification<T>(
    Specification<T> left,
    Specification<T> right) : Specification<T>
{
    public override Expression<Func<T, bool>> Criteria
    {
        get
        {
            var param = Expression.Parameter(typeof(T));
            var body = Expression.OrElse(
                Expression.Invoke(left.Criteria, param),
                Expression.Invoke(right.Criteria, param));
            return Expression.Lambda<Func<T, bool>>(body, param);
        }
    }
}

// ✅ Correct: business-rule specifications — single source of truth for each rule
public sealed class ActiveUserSpecification : Specification<User>
{
    // The definition of "active user" lives in ONE place
    public override Expression<Func<User, bool>> Criteria =>
        u => u.IsActive
          && u.IsEmailVerified
          && !u.IsDeleted
          && !u.IsLocked;
}

public sealed class RecentlyActiveUserSpecification : Specification<User>
{
    private readonly DateTime _cutoff;

    public RecentlyActiveUserSpecification(TimeSpan window)
        => _cutoff = DateTime.UtcNow.Subtract(window);

    public override Expression<Func<User, bool>> Criteria =>
        u => u.LastLoginAt >= _cutoff;
}

public sealed class ConversationMemberSpecification : Specification<Conversation>
{
    private readonly Guid _userId;

    public ConversationMemberSpecification(Guid userId) => _userId = userId;

    public override Expression<Func<Conversation, bool>> Criteria =>
        c => c.Participants.Any(p => p.UserId == _userId) && !c.IsDeleted;
}

// ✅ Correct: repository uses specifications — consistent, readable
public sealed class UserRepository(AppDbContext context)
{
    public async Task<IReadOnlyList<User>> GetAsync(
        Specification<User> spec,
        CancellationToken ct)
    {
        return await context.Users
            .AsNoTracking()
            .Where(spec.Criteria)
            .ToListAsync(ct);
    }

    public async Task<int> CountAsync(
        Specification<User> spec,
        CancellationToken ct)
    {
        return await context.Users
            .Where(spec.Criteria)
            .CountAsync(ct);
    }
}

// ✅ Correct: compose specifications at the call site
public async Task<IReadOnlyList<User>> GetActiveRecentUsersAsync(CancellationToken ct)
{
    var spec = new ActiveUserSpecification()
        .And(new RecentlyActiveUserSpecification(TimeSpan.FromDays(30)));

    return await _userRepository.GetAsync(spec, ct);
}

// ✅ Correct: unit-testable without DB
public void ValidateUserEligibility(User user)
{
    var spec = new ActiveUserSpecification();

    // IsSatisfiedBy works in-memory — no DB needed for unit tests
    if (!spec.IsSatisfiedBy(user))
        throw new DomainException("User is not eligible for this operation");
}

// ❌ Wrong: duplicated filtering logic — diverges over time
public async Task<IReadOnlyList<User>> GetActiveUsersForNotificationAsync(CancellationToken ct)
{
    return await context.Users
        .Where(u => u.IsActive && u.IsEmailVerified && !u.IsDeleted) // Missing IsLocked check
        .ToListAsync(ct);
}

public async Task<int> CountActiveUsersAsync(CancellationToken ct)
{
    return await context.Users
        .Where(u => u.IsActive && !u.IsDeleted && u.IsEmailVerified && !u.IsLocked) // Different order, same intent
        .CountAsync(ct);
}
// When the definition changes, one gets updated, the other doesn't.
```

## The Trap

```csharp
// A senior developer correctly implements specifications.
// All filtering logic centralised. Business rules consistent. Ships.
// The trap: Expression.Invoke() does not translate to SQL in all EF Core versions.

// The AndSpecification above uses Expression.Invoke() — which EF Core 6 and earlier
// cannot translate. It falls back to client-side evaluation silently,
// loading ALL rows then filtering in memory.
// 1 million users table: "active users" query loads 1 million rows into app memory.
// No exception. No warning in older EF Core. Just extreme memory pressure.

// EF Core 9 handles Expression.Invoke() correctly via expression tree rewriting.
// But if your target is EF Core 6/7/8, use LinqKit's AsExpandable() or
// rewrite using a different composition strategy.

// Fix for EF Core 6/7/8: use PredicateBuilder from LinqKit
// Install: LinqKit.Microsoft.EntityFrameworkCore

using LinqKit;

public sealed class AndSpecification<T>(
    Specification<T> left,
    Specification<T> right) : Specification<T>
{
    public override Expression<Func<T, bool>> Criteria
        => left.Criteria.And(right.Criteria); // LinqKit — SQL-translatable composition

    // In DbContext configuration:
    // options.UseSqlServer(connStr).WithExpressionExpanding();
    // OR use AsExpandable() in every LINQ query
}

// Verify SQL translation in development — NEVER assume complex expressions translate:
// Enable logging: options.LogTo(Console.WriteLine, LogLevel.Information)
// Look for "CLIENT EVALUATION" warnings — that means data loaded in memory
```

## The Exception
Simple, single-use queries that are never duplicated — a one-off admin query to find users by a specific internal ID range — do not need a Specification. The pattern pays off when the same business rule appears in multiple places or when the rule is complex enough that human error in duplication is likely. A `WHERE Id = @id` does not need a Specification. A `WHERE IsActive AND IsEmailVerified AND NOT IsDeleted AND LastLoginAt > 30 days` used in 8 places absolutely does.

## Before You Merge
- Is each business-rule concept expressed as exactly one named Specification class — not repeated inline predicates?
- Does the specification composition (`And`, `Or`) produce SQL-translatable expressions — verified with EF Core query logging?
- Is `IsSatisfiedBy()` used in unit tests — so business rules are tested without a database?
- Are Specification classes in the Domain or Application layer — not in Infrastructure?
- When the definition of a business rule changes, is there exactly one file to update?
