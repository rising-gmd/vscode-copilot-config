# Dapper Best Practices

Use Dapper for performance-critical reads, complex queries, and reporting. Complement EF Core where raw speed matters.

---

## When to Use Dapper

**Use Dapper for:**
- Reporting and analytics queries
- Complex joins EF Core doesn't optimize well
- Read-heavy operations where every millisecond counts
- Stored procedure execution
- Bulk data reads

**Use EF Core for:**
- CRUD operations
- Change tracking scenarios
- Domain model persistence
- Complex entity graphs

---

## Parameterized Queries

**ALWAYS use parameters — never string concatenation:**

```csharp
// DO - Parameterized (prevents SQL injection)
var users = await connection.QueryAsync<User>(
    "SELECT * FROM Users WHERE Email = @Email",
    new { Email = email });

// NEVER - String concatenation (SQL injection risk)
var users = await connection.QueryAsync<User>(
    $"SELECT * FROM Users WHERE Email = '{email}'");
```

---

## Async Everywhere

```csharp
// DO - Use async methods
var users = await connection.QueryAsync<User>(sql, parameters);
var user = await connection.QueryFirstOrDefaultAsync<User>(sql, parameters);
var rowsAffected = await connection.ExecuteAsync(sql, parameters);

// AVOID - Blocking calls
var users = connection.Query<User>(sql, parameters).ToList();
```

---

## Multi-Mapping

Map complex objects with joins:

```csharp
// DO - Multi-mapping for parent-child relationships
var sql = """
    SELECT u.*, o.*
    FROM Users u
    INNER JOIN Orders o ON u.Id = o.UserId
    WHERE u.Id = @UserId
    """;

var userDictionary = new Dictionary<int, User>();

var users = await connection.QueryAsync<User, Order, User>(
    sql,
    (user, order) =>
    {
        if (!userDictionary.TryGetValue(user.Id, out var currentUser))
        {
            currentUser = user;
            currentUser.Orders = new List<Order>();
            userDictionary.Add(user.Id, currentUser);
        }
        currentUser.Orders.Add(order);
        return currentUser;
    },
    new { UserId = userId },
    splitOn: "Id"); // Order.Id is the split point

return userDictionary.Values.FirstOrDefault();
```

---

## Execute Scalar

For single value returns:

```csharp
// DO - ExecuteScalar for counts/aggregates
var totalOrders = await connection.ExecuteScalarAsync<int>(
    "SELECT COUNT(*) FROM Orders WHERE UserId = @UserId",
    new { UserId = userId });

var revenue = await connection.ExecuteScalarAsync<decimal>(
    "SELECT SUM(Total) FROM Orders WHERE Year = @Year",
    new { Year = 2025 });
```

---

## Multiple Results

Execute multiple queries in one roundtrip:

```csharp
// DO - Use QueryMultiple for related data
var sql = """
    SELECT * FROM Users WHERE Id = @UserId;
    SELECT * FROM Orders WHERE UserId = @UserId;
    SELECT * FROM Addresses WHERE UserId = @UserId;
    """;

using var multi = await connection.QueryMultipleAsync(sql, new { UserId = userId });

var user = await multi.ReadSingleAsync<User>();
user.Orders = (await multi.ReadAsync<Order>()).ToList();
user.Addresses = (await multi.ReadAsync<Address>()).ToList();

return user;
```

---

## Stored Procedures

```csharp
// DO - Execute stored procedures with typed parameters
var parameters = new DynamicParameters();
parameters.Add("@StartDate", startDate);
parameters.Add("@EndDate", endDate);
parameters.Add("@TotalRevenue", dbType: DbType.Decimal, direction: ParameterDirection.Output);

await connection.ExecuteAsync(
    "sp_CalculateRevenue",
    parameters,
    commandType: CommandType.StoredProcedure);

var totalRevenue = parameters.Get<decimal>("@TotalRevenue");
```

---

## Connection Management

```csharp
// DO - Use 'using' for automatic disposal
using var connection = new SqlConnection(connectionString);
await connection.OpenAsync();
var users = await connection.QueryAsync<User>(sql);

// DO - Register IDbConnection as scoped in DI
services.AddScoped<IDbConnection>(sp =>
    new SqlConnection(configuration.GetConnectionString("Default")));

// DO - Leverage connection pooling (enabled by default)
// Connection string: "...;Max Pool Size=200;Min Pool Size=5;Pooling=true"
```

---

## Transaction Sharing with EF Core

When using Dapper alongside EF Core:

```csharp
// DO - Share transaction between EF Core and Dapper
using var transaction = await context.Database.BeginTransactionAsync();

try
{
    // EF Core operations
    await context.Orders.AddAsync(order);
    await context.SaveChangesAsync();

    // Dapper operations using same transaction
    await context.Database.GetDbConnection().ExecuteAsync(
        "UPDATE Inventory SET Quantity = Quantity - @Qty WHERE ProductId = @Id",
        new { Qty = order.Quantity, Id = order.ProductId },
        transaction: transaction.GetDbTransaction());

    await transaction.CommitAsync();
}
catch
{
    await transaction.RollbackAsync();
    throw;
}
```

---

## Buffered vs Unbuffered

```csharp
// DO - Use buffered (default) for small-medium result sets
var users = await connection.QueryAsync<User>(sql); // Buffered by default

// DO - Use unbuffered for very large result sets to reduce memory
var largeDataset = await connection.QueryAsync<LogEntry>(
    sql,
    buffered: false); // Streams results

await foreach (var log in largeDataset)
{
    // Process one at a time
    await ProcessLog(log);
}
```

---

## Type Mapping

```csharp
// DO - Map to strongly-typed objects
public class UserDto
{
    public int Id { get; init; }
    public string Email { get; init; }
    public DateTime CreatedDate { get; init; }
}

var users = await connection.QueryAsync<UserDto>(sql);

// DO - Use dynamic for ad-hoc queries
var results = await connection.QueryAsync(
    "SELECT ProductName, SUM(Quantity) AS Total FROM Sales GROUP BY ProductName");

foreach (var row in results)
{
    Console.WriteLine($"{row.ProductName}: {row.Total}");
}
```

---

## Explicit Column Selection

```csharp
// DO - Select only needed columns
var sql = "SELECT Id, Email, FirstName, LastName FROM Users WHERE IsActive = 1";

// AVOID - SELECT * (slower, fragile to schema changes)
var sql = "SELECT * FROM Users WHERE IsActive = 1";
```

---

## Performance Tips

1. **Use `IN` clauses carefully** — SQL Server optimizes up to ~2000 parameters
2. **Table-valued parameters** for large lists:
```csharp
var dt = new DataTable();
dt.Columns.Add("Id", typeof(int));
foreach (var id in ids) dt.Rows.Add(id);

var users = await connection.QueryAsync<User>(
    "SELECT * FROM Users WHERE Id IN (SELECT Id FROM @Ids)",
    new { Ids = dt.AsTableValuedParameter("dbo.IdList") });
```

3. **Compiled queries** — Dapper caches query plans automatically
4. **Connection pooling** — Reuse connections, don't create per query

---

## Error Handling

```csharp
try
{
    var result = await connection.QueryAsync<User>(sql, parameters);
    return result;
}
catch (SqlException ex)
{
    _logger.LogError(ex, "Database query failed: {Sql}", sql);
    throw new DataAccessException("Failed to retrieve users", ex);
}
```

---

## Checklist

- [ ] All queries parameterized (no string concatenation)
- [ ] Async methods used everywhere
- [ ] Multi-mapping for complex joins
- [ ] QueryMultiple for related data in one roundtrip
- [ ] Transactions shared with EF Core when needed
- [ ] Connection managed with `using` or DI
- [ ] Explicit column selection (no SELECT *)
- [ ] Error logging with query details
- [ ] Performance profiled for queries > 100ms

---

**Dapper + EF Core together = Best of both worlds. Use each where it excels.**