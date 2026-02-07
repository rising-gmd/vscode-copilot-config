# C# Coding Conventions & Naming

Follow Microsoft's official standards. Consistent code is readable code. These conventions are non-negotiable.

---

## Naming Conventions

### PascalCase

- Classes: `UserService`, `OrderController`
- Methods: `GetUserById`, `CalculateTotal`
- Public properties: `FirstName`, `CreatedDate`
- Interfaces: `IRepository`, `IUserService` (prefix with `I`)
- Namespaces: `MyApp.Features.Users`
- Constants: `MaxRetryCount`, `DefaultPageSize`
- Enums: `OrderStatus`, `UserRole`
- Records: `UserDto`, `Address`

```csharp
public class UserService : IUserService
{
    public const int MaxLoginAttempts = 3;
    
    public string FirstName { get; init; }
    
    public async Task<User> GetUserById(int id) { }
}

public interface IUserService { }

public enum OrderStatus { Pending, Completed, Cancelled }
```

### camelCase

- Local variables: `userName`, `totalCount`
- Method parameters: `userId`, `pageSize`
- Private fields with underscore prefix: `_userRepository`, `_logger`

```csharp
public class OrderService
{
    private readonly IOrderRepository _orderRepository;
    private readonly ILogger<OrderService> _logger;

    public async Task<Order> CreateOrder(int customerId, List<OrderItem> items)
    {
        var order = new Order();
        var totalPrice = items.Sum(i => i.Price);
        
        _logger.LogInformation("Creating order for customer {CustomerId}", customerId);
        return await _orderRepository.AddAsync(order);
    }
}
```

---

## File-Scoped Namespaces

```csharp
// DO - File-scoped namespace (C# 10+)
namespace MyApp.Features.Users;

public class UserService { }

// AVOID - Block-scoped namespace (adds unnecessary nesting)
namespace MyApp.Features.Users
{
    public class UserService { }
}
```

---

## Using Directives

```csharp
// DO - Outside namespace, sorted, System namespaces first
using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.EntityFrameworkCore;
using MyApp.Domain.Entities;

namespace MyApp.Features.Users;

// AVOID - Inside namespace
namespace MyApp.Features.Users
{
    using System;
    public class UserService { }
}
```

---

## Type Declarations

### Use `var` for Obvious Types

```csharp
// DO - Use var when type is obvious
var users = new List<User>();
var context = new ApplicationDbContext();
var stream = File.Create(path);

// DO - Explicit type for clarity
User user = GetUserFromExternalService();
decimal totalRevenue = CalculateRevenue();
```

### Prefer Built-in Types

```csharp
// DO - Built-in type names
int count = 10;
string name = "John";
bool isActive = true;
decimal price = 99.99m;

// AVOID - Framework types
Int32 count = 10;
String name = "John";
Boolean isActive = true;
Decimal price = 99.99m;
```

---

## Bracing Style

### Allman Style (Microsoft Standard)

```csharp
// DO - Allman style (braces on new lines)
if (user.IsActive)
{
    SendWelcomeEmail(user);
}
else
{
    LogInactiveUser(user);
}

public class User
{
    public int Id { get; init; }
    
    public void Activate()
    {
        IsActive = true;
    }
}

// AVOID - K&R style
if (user.IsActive) {
    SendWelcomeEmail(user);
}
```

### Always Use Braces

```csharp
// DO - Always use braces
if (condition)
{
    DoSomething();
}

// AVOID - No braces (error-prone)
if (condition)
    DoSomething();
```

---

## Member Ordering

```csharp
public class UserService
{
    // 1. Constants
    private const int MaxRetryAttempts = 3;
    
    // 2. Static fields
    private static readonly TimeSpan CacheExpiration = TimeSpan.FromMinutes(10);
    
    // 3. Instance fields (private, with underscore prefix)
    private readonly IUserRepository _userRepository;
    private readonly ILogger<UserService> _logger;
    
    // 4. Constructors
    public UserService(IUserRepository userRepository, ILogger<UserService> logger)
    {
        _userRepository = userRepository;
        _logger = logger;
    }
    
    // 5. Public properties
    public int TotalUsers { get; private set; }
    
    // 6. Public methods
    public async Task<User> GetUserAsync(int id)
    {
        return await _userRepository.GetByIdAsync(id);
    }
    
    // 7. Private methods
    private void LogUserAccess(int userId)
    {
        _logger.LogInformation("User {UserId} accessed", userId);
    }
}
```

---

## Comments

### XML Comments for Public APIs

```csharp
/// <summary>
/// Retrieves a user by their unique identifier.
/// </summary>
/// <param name="id">The unique identifier of the user.</param>
/// <param name="ct">Cancellation token for async operation.</param>
/// <returns>The user if found; otherwise, null.</returns>
/// <exception cref="ArgumentException">Thrown when id is less than or equal to zero.</exception>
public async Task<User?> GetUserByIdAsync(int id, CancellationToken ct)
{
    if (id <= 0)
        throw new ArgumentException("User ID must be greater than zero", nameof(id));
        
    return await _context.Users.FindAsync(id, ct);
}
```

### Inline Comments — Why, Not What

```csharp
// DO - Explain why
// Retry logic needed because external API has transient failures
await retryPolicy.ExecuteAsync(() => externalApi.SendData(data));

// Cache miss is expected on first call after deployment
var cachedData = await _cache.GetAsync(key) ?? await FetchFromDatabase(key);

// AVOID - Obvious statements
// Get user by id
var user = await GetUserById(id);

// Loop through items
foreach (var item in items) { }
```

---

## String Handling

### String Interpolation

```csharp
// DO - String interpolation for clarity
var message = $"User {userName} logged in at {DateTime.UtcNow}";

// AVOID - Concatenation
var message = "User " + userName + " logged in at " + DateTime.UtcNow;
```

### Verbatim Strings

```csharp
// DO - Verbatim for paths and multi-line
var path = @"C:\Users\Documents\file.txt";
var sql = @"
    SELECT u.Id, u.Name
    FROM Users u
    WHERE u.IsActive = 1";
```

### Raw String Literals (C# 11+)

```csharp
// DO - Raw strings for SQL, JSON, etc.
var sql = """
    SELECT u.Id, u.Name, u.Email
    FROM Users u
    WHERE u.CreatedDate > @StartDate
    ORDER BY u.Name
    """;
```

---

## Exception Handling

```csharp
// DO - Catch specific exceptions
try
{
    var user = await _userService.GetUserAsync(id, ct);
}
catch (NotFoundException ex)
{
    _logger.LogWarning(ex, "User {UserId} not found", id);
    return NotFound();
}
catch (DbException ex)
{
    _logger.LogError(ex, "Database error retrieving user {UserId}", id);
    throw;
}

// AVOID - Catching Exception without filter
try
{
    var user = await _userService.GetUserAsync(id, ct);
}
catch (Exception ex)
{
    // Too broad
}
```

---

## LINQ

### Method Syntax (Preferred)

```csharp
// DO - Method syntax (more composable)
var activeUsers = users
    .Where(u => u.IsActive)
    .OrderBy(u => u.LastName)
    .Select(u => new UserDto(u.Id, u.Name));

// OK - Query syntax when it improves readability
var activeUsers =
    from u in users
    where u.IsActive
    orderby u.LastName
    select new UserDto(u.Id, u.Name);
```

### Avoid Repeated Enumeration

```csharp
// DO - Materialize once if using multiple times
var activeUsers = users.Where(u => u.IsActive).ToList();
var count = activeUsers.Count;
var firstUser = activeUsers.FirstOrDefault();

// AVOID - Multiple enumerations
var activeUsers = users.Where(u => u.IsActive);
var count = activeUsers.Count(); // Enumerates
var firstUser = activeUsers.FirstOrDefault(); // Enumerates again
```

---

## Async/Await

```csharp
// DO - Async all the way
public async Task<User> GetUserAsync(int id, CancellationToken ct)
{
    return await _repository.GetByIdAsync(id, ct);
}

// DO - Include CancellationToken parameter
public async Task<List<User>> GetAllUsersAsync(CancellationToken ct)
{
    return await _context.Users.ToListAsync(ct);
}

// NEVER - Block on async code
public User GetUser(int id)
{
    return GetUserAsync(id, default).Result; // Deadlock risk
}

// NEVER - async void (except event handlers)
public async void SaveUser(User user)
{
    await _repository.SaveAsync(user);
}
```

---

## Dispose Pattern

```csharp
// DO - Use 'using' for IDisposable
using var connection = new SqlConnection(connectionString);
await connection.OpenAsync();

// For multiple disposables
using (var context = new ApplicationDbContext())
using (var transaction = await context.Database.BeginTransactionAsync())
{
    // Work
    await transaction.CommitAsync();
}

// C# 8+ — using declaration
public async Task ProcessFile(string path)
{
    using var stream = File.OpenRead(path);
    // Stream disposed at end of method
    await ProcessStream(stream);
}
```

---

## Primary Constructors (C# 12+)

```csharp
// DO - Primary constructors for DI
public class UserService(
    IUserRepository userRepository,
    ILogger<UserService> logger) : IUserService
{
    public async Task<User?> GetUserAsync(int id, CancellationToken ct)
    {
        logger.LogInformation("Fetching user {UserId}", id);
        return await userRepository.GetByIdAsync(id, ct);
    }
}
```

---

## Records

```csharp
// DO - Records for DTOs and value objects
public record UserDto(int Id, string Email, string FirstName, string LastName);

public record Address(string Street, string City, string State, string Zip)
{
    public string FullAddress => $"{Street}, {City}, {State} {Zip}";
}

// Positional records with validation
public record CreateUserRequest(string Email, string Password)
{
    public CreateUserRequest : this()
    {
        if (string.IsNullOrWhiteSpace(Email))
            throw new ArgumentException("Email is required");
    }
}
```

---

## Checklist

- [ ] PascalCase for types, methods, public properties
- [ ] camelCase for parameters, locals, private fields with `_` prefix
- [ ] File-scoped namespaces
- [ ] Using directives outside namespace, sorted
- [ ] `var` for obvious types, explicit when clarity needed
- [ ] Built-in type names (`int` not `Int32`)
- [ ] Allman bracing style, always use braces
- [ ] Members ordered: constants → fields → constructors → properties → methods
- [ ] XML comments on public APIs
- [ ] Async all the way with `CancellationToken`
- [ ] `using` for IDisposable
- [ ] Primary constructors for DI (C# 12+)
- [ ] Records for DTOs and value objects

---

**Consistency > personal preference. Follow the standard.**