# SQL Injection Prevention
> Verified against: .NET 9 | C# 13 | EF Core 9.x | Dapper 2.x
> Last reviewed: 2026-02-22

## The Law
Never concatenate user input into SQL strings — use parameterized queries in Dapper, LINQ in EF Core, or `FromSqlInterpolated` for raw SQL.

## Why This Kills You At Scale
SQL injection on a login endpoint with `WHERE Username = '{input}'` allows `' OR '1'='1` to bypass authentication entirely and return the first user in the table — often an admin. At 100k users, a single injectable endpoint exposed to the internet is found by automated scanners within hours of deployment. Data exfiltration, authentication bypass, and data deletion all become possible from a single vulnerable parameter.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;
using Dapper;

// ✅ Correct: EF Core LINQ — always parameterized automatically
public sealed class UserRepository(AppDbContext context)
{
    public async Task<User?> GetByEmailAsync(string email, CancellationToken ct)
    {
        // EF Core translates this to: WHERE Email = @p0
        // @p0 is parameterized — SQL injection impossible
        return await context.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Email == email, ct);
    }

    // ✅ Correct: EF Core raw SQL — use FromSqlInterpolated, not FromSqlRaw with concat
    public async Task<User?> GetByEmailRawAsync(string email, CancellationToken ct)
    {
        // FormattableString interpolation → SqlParameter — still parameterized
        return await context.Users
            .FromSqlInterpolated($"SELECT * FROM Users WHERE Email = {email}")
            .AsNoTracking()
            .FirstOrDefaultAsync(ct);
    }

    // ✅ Correct: EF Core ExecuteUpdate — parameterized automatically
    public async Task UpdateLastLoginAsync(Guid userId, DateTime loginAt, CancellationToken ct)
    {
        await context.Users
            .Where(u => u.Id == userId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(u => u.LastLoginAt, loginAt), ct);
    }
}

// ✅ Correct: Dapper — always use parameters, never string interpolation
public sealed class DapperUserRepository(IDbConnectionFactory factory)
{
    public async Task<User?> GetByEmailAsync(string email, CancellationToken ct)
    {
        using var conn = factory.CreateConnection();

        // Named parameter @Email — Dapper passes as SqlParameter
        return await conn.QueryFirstOrDefaultAsync<User>(
            new CommandDefinition(
                "SELECT * FROM Users WHERE Email = @Email AND IsDeleted = 0",
                new { Email = email },
                cancellationToken: ct));
    }

    // ✅ Correct: dynamic WHERE clause — still parameterized
    public async Task<IEnumerable<User>> SearchAsync(
        string? username,
        bool? isActive,
        CancellationToken ct)
    {
        using var conn = factory.CreateConnection();
        var sb = new System.Text.StringBuilder("SELECT * FROM Users WHERE 1=1");
        var parameters = new DynamicParameters();

        if (!string.IsNullOrWhiteSpace(username))
        {
            sb.Append(" AND Username LIKE @Username");
            parameters.Add("Username", $"%{username}%"); // Wildcard in value, not in SQL
        }

        if (isActive.HasValue)
        {
            sb.Append(" AND IsActive = @IsActive");
            parameters.Add("IsActive", isActive.Value);
        }

        return await conn.QueryAsync<User>(
            new CommandDefinition(sb.ToString(), parameters, cancellationToken: ct));
    }
}

// ❌ Wrong: string interpolation in raw SQL — injection possible
public class VulnerableRepository
{
    public async Task<User?> GetByEmailInsecureAsync(string email)
    {
        using var conn = _factory.CreateConnection();
        // Attacker sends: ' OR 1=1; DROP TABLE Users; --
        var sql = $"SELECT * FROM Users WHERE Email = '{email}'";
        return await conn.QueryFirstOrDefaultAsync<User>(sql);
    }
}

// ❌ Wrong: FromSqlRaw with string concat — injection possible
public class VulnerableEfCoreRepo(AppDbContext context)
{
    public async Task<User?> GetInsecureAsync(string email, CancellationToken ct)
    {
        // String concat into FromSqlRaw bypasses parameterization
        return await context.Users
            .FromSqlRaw($"SELECT * FROM Users WHERE Email = '{email}'")
            .FirstOrDefaultAsync(ct);
    }
}
```

## The Trap

```csharp
// A senior developer correctly uses parameterized queries everywhere.
// Passes penetration test. Ships.
// The trap: ORDER BY and column names cannot be parameterized in SQL.

public async Task<IEnumerable<Message>> GetMessagesAsync(
    Guid conversationId,
    string sortColumn,  // User-supplied: "SentAt", "SenderId"
    string sortDirection, // User-supplied: "ASC", "DESC"
    CancellationToken ct)
{
    using var conn = _factory.CreateConnection();

    // BUG: Cannot parameterize column names or sort direction in SQL
    // Developer uses string interpolation "just for ORDER BY"
    var sql = $"""
        SELECT * FROM Messages
        WHERE ConversationId = @ConversationId
        ORDER BY {sortColumn} {sortDirection}
        """;
    // Attacker sends sortColumn = "1; DROP TABLE Messages; --"
    // Injection successful despite "using Dapper correctly"

    return await conn.QueryAsync<Message>(
        new CommandDefinition(sql, new { ConversationId = conversationId }, cancellationToken: ct));
}

// Fix: allowlist for column names and directions — never trust user input for identifiers
private static readonly HashSet<string> AllowedSortColumns = ["SentAt", "SenderId"];
private static readonly HashSet<string> AllowedDirections = ["ASC", "DESC"];

public async Task<IEnumerable<Message>> GetMessagesSafeAsync(
    Guid conversationId,
    string sortColumn,
    string sortDirection,
    CancellationToken ct)
{
    // Validate against allowlist before interpolating
    if (!AllowedSortColumns.Contains(sortColumn))
        sortColumn = "SentAt"; // Default to safe value

    if (!AllowedDirections.Contains(sortDirection.ToUpperInvariant()))
        sortDirection = "DESC";

    using var conn = _factory.CreateConnection();
    var sql = $"""
        SELECT * FROM Messages
        WHERE ConversationId = @ConversationId
        ORDER BY {sortColumn} {sortDirection}
        """;

    return await conn.QueryAsync<Message>(
        new CommandDefinition(sql, new { ConversationId = conversationId }, cancellationToken: ct));
}
```

## The Exception
There are no exceptions to parameterized queries for user-supplied values. Column names, table names, and sort directions that cannot be parameterized must use an allowlist validation before interpolation — they are never passed through directly. Stored procedures do not exempt you from injection — they can be vulnerable to dynamic SQL within the procedure itself.

## Before You Merge
- Is every `FromSqlRaw` call using `@param` syntax with a parameters object — never string interpolation of user input?
- Are all Dapper queries using named parameters — never `$"...{userInput}..."` inside the SQL string?
- Do dynamic `ORDER BY` columns use an allowlist — not direct user-supplied column names?
- Are stored procedure calls using `DynamicParameters` — not concatenated command text?
- Has the SQL generated by EF Core been inspected for parameterization via `EnableSensitiveDataLogging` in development?
