# Connection Pooling
> Verified against: .NET 9 | C# 13 | Microsoft.Data.SqlClient 5.x | StackExchange.Redis 2.x
> Last reviewed: 2026-02-22

## The Law
Never open a database or Redis connection inside a loop, never hold connections open across awaits that do not need them, and size your pool explicitly based on measured concurrency — not defaults.

## Why This Kills You At Scale
SQL Server's default maximum connection pool size is 100. At one billion users with 10 pods, each pod has 100 connections = 1,000 total. Under load, 10,000 concurrent requests across 10 pods exhaust all 1,000 connections within seconds. New requests queue waiting for a free connection. P50 latency goes from 5ms to 800ms. The queue grows faster than it drains. Every subsequent request times out. The database is idle — it has capacity — but no application can reach it. Connection exhaustion is the invisible wall between staging (100 users, fine) and production (100,000 users, catastrophic failure).

## The Pattern

```csharp
#nullable enable
using System.Data;
using Microsoft.Data.SqlClient;
using StackExchange.Redis;

// ✅ Correct: connection string tuned for scale
// Add to your SQL connection string:
// Max Pool Size=300;         -- Raise from default 100 — tune per pod concurrency measurement
// Min Pool Size=10;          -- Keep 10 warm — eliminates cold-start connection overhead
// Connect Timeout=15;        -- Fail fast rather than queue indefinitely
// Connection Lifetime=300;   -- Recycle connections every 5 minutes — prevent stale sockets
// Connection Reset=true;     -- Reset state (transactions, SET options) between borrows
// Encrypt=true;              -- TLS — mandatory for production
// TrustServerCertificate=false; -- Verify certificate — never true in production

// ✅ Correct: IDbConnectionFactory — abstracts connection creation for testability
public interface IDbConnectionFactory
{
    IDbConnection CreateConnection();
    Task<IDbConnection> CreateOpenConnectionAsync(CancellationToken ct = default);
}

public sealed class SqlConnectionFactory(IOptions<DatabaseSettings> options)
    : IDbConnectionFactory
{
    private readonly string _connectionString = options.Value.ConnectionString;

    public IDbConnection CreateConnection()
        => new SqlConnection(_connectionString);

    public async Task<IDbConnection> CreateOpenConnectionAsync(CancellationToken ct = default)
    {
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync(ct);
        return connection;
    }
}

// ✅ Correct: using pattern — connection returned to pool immediately after use
public sealed class MessageDapperRepository(IDbConnectionFactory factory)
{
    public async Task<IReadOnlyList<MessageDto>> GetForConversationAsync(
        Guid conversationId,
        int pageSize,
        Guid? cursor,
        CancellationToken ct)
    {
        // ✅ Connection open only for the duration of the query — returned to pool immediately
        using var conn = await factory.CreateOpenConnectionAsync(ct);

        return (await conn.QueryAsync<MessageDto>(
            new CommandDefinition(
                """
                SELECT TOP (@PageSize) Id, Content, SenderId, SentAt
                FROM Messages
                WHERE ConversationId = @ConvId
                  AND IsDeleted = 0
                  AND (@Cursor IS NULL OR SentAt < @Cursor)
                ORDER BY SentAt DESC
                """,
                new { ConvId = conversationId, PageSize = pageSize, Cursor = cursor },
                cancellationToken: ct))).ToList();

        // ✅ using disposes connection here — returned to pool, not closed
    }
}

// ✅ Correct: Redis connection — one multiplexer per application, never per request
// IConnectionMultiplexer is thread-safe and designed to be reused
// Creating one per request is a fatal mistake — connection handshake is expensive
public sealed class RedisConnectionFactory(IOptions<RedisSettings> options)
{
    // ✅ Lazy<T> — created once, thread-safe, shared for lifetime of application
    private readonly Lazy<IConnectionMultiplexer> _connection =
        new(() => ConnectionMultiplexer.Connect(new ConfigurationOptions
        {
            EndPoints = { options.Value.ConnectionString },
            AbortOnConnectFail = false,
            ConnectRetry = 5,
            ReconnectRetryPolicy = new ExponentialRetry(5_000, 60_000),
            SyncTimeout = 5_000,
            AsyncTimeout = 5_000,
            // ✅ Multiple connections inside the multiplexer for throughput
            SocketManager = SocketManager.ThreadPool,
        }));

    public IConnectionMultiplexer GetConnection() => _connection.Value;
    public IDatabase GetDatabase(int db = 0) => _connection.Value.GetDatabase(db);
}

// ✅ Correct: Register as singleton in DI
// builder.Services.AddSingleton<RedisConnectionFactory>();
// builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
//     sp.GetRequiredService<RedisConnectionFactory>().GetConnection());

// ✅ Correct: EF Core connection pool — DbContext is scoped, pool is under the hood
// DbContext does NOT hold an open connection for its entire lifetime
// Connection is acquired when a query runs, released when the query completes
// This is the default — do not disable connection resiliency

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString, sqlOptions =>
    {
        sqlOptions.EnableRetryOnFailure(
            maxRetryCount: 5,
            maxRetryDelay: TimeSpan.FromSeconds(30),
            errorNumbersToAdd: null); // Retry on standard transient errors

        sqlOptions.CommandTimeout(30); // 30 second query timeout — not infinite
    }));

// ❌ Wrong: opening connection inside a loop — exhausts pool
public async Task ProcessBatchWrong(IEnumerable<Guid> messageIds, CancellationToken ct)
{
    foreach (var id in messageIds)
    {
        // Opens a new connection per iteration — 1000 IDs = 1000 connections simultaneously
        using var conn = await factory.CreateOpenConnectionAsync(ct);
        await conn.ExecuteAsync("UPDATE Messages SET Processed = 1 WHERE Id = @Id",
            new { Id = id });
        // Returned to pool, but next iteration opens another immediately
        // Pool exhausted under any real load
    }
}

// ✅ Correct: batch operation — one connection, one trip
public async Task ProcessBatchCorrect(IEnumerable<Guid> messageIds, CancellationToken ct)
{
    using var conn = await factory.CreateOpenConnectionAsync(ct);

    // ✅ Table-valued parameter OR JSON — one roundtrip for the entire batch
    await conn.ExecuteAsync(
        """
        UPDATE Messages
        SET Processed = 1
        WHERE Id IN (SELECT value FROM OPENJSON(@Ids))
        """,
        new { Ids = JsonSerializer.Serialize(messageIds) });
}
```

## The Trap

```csharp
// A senior developer correctly configures pool sizes, uses using pattern,
// shares IConnectionMultiplexer as singleton. Ships.
// The trap: EF Core + Dapper sharing a SqlConnection causes silent data corruption.

public sealed class HybridRepository(AppDbContext context, IDbConnectionFactory factory)
{
    public async Task<(UserDto User, IReadOnlyList<MessageDto> Messages)> GetAsync(
        Guid userId, CancellationToken ct)
    {
        // ✅ EF Core owns its own connection internally — correct
        var user = await context.Users.FindAsync([userId], ct);

        // ⚠ Getting EF Core's underlying connection and passing to Dapper
        var efConnection = context.Database.GetDbConnection();
        await efConnection.OpenAsync(ct); // Opens EF Core's connection manually

        // BUG: Dapper executes on EF Core's connection while EF Core may have
        // an active transaction or set of connection-level state (SET NOCOUNT, isolation level)
        // that Dapper is now operating under without knowing it.
        // If EF Core's transaction rolls back, Dapper's read was inside the transaction
        // and the data Dapper returned may no longer exist.
        var messages = await efConnection.QueryAsync<MessageDto>(
            "SELECT * FROM Messages WHERE SenderId = @UserId",
            new { UserId = userId });

        return (user!.ToDto(), messages.ToList());
    }
}

// Fix: Dapper uses its OWN connection from the factory — never EF Core's connection
public async Task<(UserDto User, IReadOnlyList<MessageDto> Messages)> GetFixedAsync(
    Guid userId, CancellationToken ct)
{
    // EF Core on its own connection
    var user = await context.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct)
        ?? throw new NotFoundException($"User {userId} not found");

    // Dapper on its own independent connection from the factory
    using var conn = await factory.CreateOpenConnectionAsync(ct);
    var messages = await conn.QueryAsync<MessageDto>(
        "SELECT Id, Content, SentAt FROM Messages WHERE SenderId = @UserId ORDER BY SentAt DESC",
        new { UserId = userId });

    return (user.ToDto(), messages.ToList());
}
```

## The Exception
Unit tests and integration tests using SQLite in-memory databases do not need pool configuration — SQLite in-memory creates a fresh database per connection, and pool sizing is irrelevant when there is a single test at a time. Do not apply production pool tuning to test infrastructure. Conversely, never use SQLite for integration tests on SQL Server-targeted code — the query plan, locking behavior, and feature set differ enough that tests pass on SQLite and fail silently on SQL Server.

## Before You Merge
- Is `Max Pool Size` explicitly set in the connection string — tuned to measured pod concurrency, not left at default 100?
- Is `IConnectionMultiplexer` (Redis) registered as `Singleton` — one instance for the entire application lifetime?
- Is `Connection Lifetime` set to 300 seconds — preventing socket rot on long-lived pool connections?
- Are all Dapper connections opened via `IDbConnectionFactory` — never via EF Core's `GetDbConnection()`?
- Is the EF Core command timeout set to 30 seconds — preventing runaway queries from holding connections indefinitely?
