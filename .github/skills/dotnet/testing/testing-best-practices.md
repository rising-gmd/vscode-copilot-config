# Testing Best Practices

Untested code is broken code. Write tests that give confidence, run fast, and survive refactoring.

---

## Test Pyramid

```
        /\
       /  \      Unit Tests (70-80%)
      /____\     - Fast, isolated, many
     /      \    Integration Tests (15-20%)
    /________\   - Medium speed, fewer
   /          \  E2E Tests (5-10%)
  /____________\ - Slow, brittle, minimal
```

---

## Unit Tests

### xUnit (Recommended)

```csharp
public class OrderServiceTests
{
    [Fact]
    public async Task CreateOrder_ValidInput_ReturnsOrderId()
    {
        // Arrange
        var mockRepo = new Mock<IOrderRepository>();
        var mockUnitOfWork = new Mock<IUnitOfWork>();
        var service = new OrderService(mockRepo.Object, mockUnitOfWork.Object);
        
        var command = new CreateOrderCommand(CustomerId: 1, Items: new List<OrderItemDto>
        {
            new(ProductId: 1, Quantity: 2)
        });

        mockRepo.Setup(r => r.AddAsync(It.IsAny<Order>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        // Act
        var result = await service.CreateOrderAsync(command, CancellationToken.None);

        // Assert
        Assert.True(result > 0);
        mockRepo.Verify(r => r.AddAsync(It.IsAny<Order>(), It.IsAny<CancellationToken>()), Times.Once);
        mockUnitOfWork.Verify(u => u.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Once);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 0)]
    [InlineData(-1, 5)]
    public async Task CreateOrder_InvalidInput_ThrowsValidationException(int customerId, int quantity)
    {
        // Arrange
        var service = new OrderService(Mock.Of<IOrderRepository>(), Mock.Of<IUnitOfWork>());
        var command = new CreateOrderCommand(customerId, new List<OrderItemDto>
        {
            new(1, quantity)
        });

        // Act & Assert
        await Assert.ThrowsAsync<ValidationException>(() =>
            service.CreateOrderAsync(command, CancellationToken.None));
    }
}
```

### FluentAssertions (Readable Assertions)

```csharp
// DO - FluentAssertions for readability
var user = await userService.GetUserAsync(1);

user.Should().NotBeNull();
user.Email.Should().Be("test@example.com");
user.IsActive.Should().BeTrue();
user.Roles.Should().Contain("Admin");
user.CreatedDate.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(5));

// Standard xUnit assertions (less readable)
Assert.NotNull(user);
Assert.Equal("test@example.com", user.Email);
Assert.True(user.IsActive);
Assert.Contains("Admin", user.Roles);
```

---

## Test Fixtures & Setup

```csharp
// Shared setup across tests
public class OrderServiceTestFixture : IDisposable
{
    public ApplicationDbContext Context { get; private set; }
    public IOrderRepository Repository { get; private set; }

    public OrderServiceTestFixture()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase(databaseName: Guid.NewGuid().ToString())
            .Options;

        Context = new ApplicationDbContext(options);
        Repository = new OrderRepository(Context);
    }

    public void Dispose()
    {
        Context.Dispose();
    }
}

public class OrderServiceTests : IClassFixture<OrderServiceTestFixture>
{
    private readonly OrderServiceTestFixture _fixture;

    public OrderServiceTests(OrderServiceTestFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Test1() { /* Use _fixture */ }
}
```

---

## Integration Tests

### WebApplicationFactory

```csharp
public class UsersApiTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;

    public UsersApiTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureServices(services =>
            {
                // Replace real DbContext with test database
                var descriptor = services.SingleOrDefault(
                    d => d.ServiceType == typeof(DbContextOptions<ApplicationDbContext>));
                
                if (descriptor != null)
                    services.Remove(descriptor);

                services.AddDbContext<ApplicationDbContext>(options =>
                {
                    options.UseInMemoryDatabase("TestDb");
                });

                // Seed test data
                var sp = services.BuildServiceProvider();
                using var scope = sp.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
                SeedTestData(db);
            });
        });

        _client = _factory.CreateClient();
    }

    [Fact]
    public async Task GetUsers_ReturnsOkWithUsers()
    {
        // Act
        var response = await _client.GetAsync("/api/users");

        // Assert
        response.Should().Be200Ok();
        var users = await response.Content.ReadFromJsonAsync<List<UserDto>>();
        users.Should().NotBeEmpty();
    }

    [Fact]
    public async Task CreateUser_ValidRequest_ReturnsCreated()
    {
        // Arrange
        var request = new CreateUserRequest("new@example.com", "password123");

        // Act
        var response = await _client.PostAsJsonAsync("/api/users", request);

        // Assert
        response.Should().Be201Created();
        var user = await response.Content.ReadFromJsonAsync<UserDto>();
        user.Email.Should().Be("new@example.com");
    }

    private void SeedTestData(ApplicationDbContext context)
    {
        context.Users.AddRange(
            new User { Email = "user1@example.com", FirstName = "John" },
            new User { Email = "user2@example.com", FirstName = "Jane" }
        );
        context.SaveChanges();
    }
}
```

### TestContainers (Real Databases)

```csharp
public class DatabaseTests : IAsyncLifetime
{
    private readonly MsSqlContainer _msSqlContainer = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-latest")
        .Build();

    private ApplicationDbContext _context;

    public async Task InitializeAsync()
    {
        await _msSqlContainer.StartAsync();

        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseSqlServer(_msSqlContainer.GetConnectionString())
            .Options;

        _context = new ApplicationDbContext(options);
        await _context.Database.MigrateAsync();
    }

    public async Task DisposeAsync()
    {
        await _context.DisposeAsync();
        await _msSqlContainer.DisposeAsync();
    }

    [Fact]
    public async Task CanQueryRealDatabase()
    {
        // Arrange
        var user = new User { Email = "test@example.com" };
        _context.Users.Add(user);
        await _context.SaveChangesAsync();

        // Act
        var retrieved = await _context.Users.FirstAsync(u => u.Email == "test@example.com");

        // Assert
        retrieved.Should().NotBeNull();
    }
}
```

---

## Mocking with Moq

```csharp
// DO - Mock dependencies, test behavior
[Fact]
public async Task SendWelcomeEmail_NewUser_CallsEmailService()
{
    // Arrange
    var mockEmailService = new Mock<IEmailService>();
    var service = new UserService(
        Mock.Of<IUserRepository>(),
        mockEmailService.Object);

    var user = new User { Email = "new@example.com", FirstName = "John" };

    // Act
    await service.SendWelcomeEmailAsync(user);

    // Assert
    mockEmailService.Verify(
        e => e.SendAsync(
            user.Email,
            "Welcome!",
            It.IsAny<string>(),
            It.IsAny<CancellationToken>()),
        Times.Once);
}

// Setup return values
mockRepo.Setup(r => r.GetByIdAsync(1, It.IsAny<CancellationToken>()))
    .ReturnsAsync(new User { Id = 1, Email = "test@example.com" });

// Setup exceptions
mockRepo.Setup(r => r.GetByIdAsync(999, It.IsAny<CancellationToken>()))
    .ThrowsAsync(new NotFoundException("User not found"));

// Verify method never called
mockEmailService.Verify(
    e => e.SendAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()),
    Times.Never);
```

---

## Test Naming

```csharp
// DO - Descriptive test names
// Format: MethodName_Scenario_ExpectedBehavior

[Fact]
public void GetUser_UserExists_ReturnsUser() { }

[Fact]
public void GetUser_UserDoesNotExist_ReturnsNull() { }

[Fact]
public void CreateOrder_InvalidCustomerId_ThrowsValidationException() { }

[Fact]
public async Task ProcessPayment_InsufficientFunds_ReturnsFailed() { }
```

---

## AAA Pattern (Arrange-Act-Assert)

```csharp
[Fact]
public async Task CalculateTotal_WithDiscount_ReturnsDiscountedAmount()
{
    // Arrange
    var order = new Order();
    order.AddItem(new Product { Price = 100 }, quantity: 2);
    var discount = new Discount { Percentage = 10 };

    // Act
    var total = order.CalculateTotal(discount);

    // Assert
    total.Should().Be(180); // 200 - 10% = 180
}
```

---

## Test Data Builders

```csharp
// DO - Use builder pattern for complex test data
public class UserBuilder
{
    private string _email = "test@example.com";
    private string _firstName = "John";
    private string _lastName = "Doe";
    private bool _isActive = true;

    public UserBuilder WithEmail(string email)
    {
        _email = email;
        return this;
    }

    public UserBuilder WithName(string firstName, string lastName)
    {
        _firstName = firstName;
        _lastName = lastName;
        return this;
    }

    public UserBuilder Inactive()
    {
        _isActive = false;
        return this;
    }

    public User Build() => new()
    {
        Email = _email,
        FirstName = _firstName,
        LastName = _lastName,
        IsActive = _isActive
    };
}

// Usage in tests
[Fact]
public void Test()
{
    var user = new UserBuilder()
        .WithEmail("admin@example.com")
        .WithName("Jane", "Smith")
        .Build();
}
```

---

## Coverage Goals

```bash
# Run with coverage
dotnet test --collect:"XPlat Code Coverage"

# Generate report
dotnet tool install -g dotnet-reportgenerator-globaltool
reportgenerator "-reports:**/coverage.cobertura.xml" "-targetdir:coverage" "-reporttypes:Html"
```

**Coverage Targets:**
- Domain Layer: 90%+
- Application Layer (Handlers): 80%+
- Infrastructure Layer: 60%+
- API Layer: 50%+

---

## Performance Tests (BenchmarkDotNet)

```csharp
[MemoryDiagnoser]
public class OrderServiceBenchmarks
{
    private List<Order> _orders;

    [GlobalSetup]
    public void Setup()
    {
        _orders = Enumerable.Range(1, 1000)
            .Select(i => new Order { Id = i, Total = i * 10 })
            .ToList();
    }

    [Benchmark]
    public decimal CalculateTotalLinq()
    {
        return _orders.Sum(o => o.Total);
    }

    [Benchmark]
    public decimal CalculateTotalForLoop()
    {
        decimal total = 0;
        foreach (var order in _orders)
            total += order.Total;
        return total;
    }
}

// Run: dotnet run -c Release
```

---

## Snapshot Testing

```csharp
// DO - Snapshot test for DTOs to catch unintended changes
[Fact]
public void UserDto_Snapshot_MatchesExpected()
{
    var user = new UserDto(
        Id: 1,
        Email: "test@example.com",
        FirstName: "John",
        LastName: "Doe");

    var json = JsonSerializer.Serialize(user, new JsonSerializerOptions { WriteIndented = true });

    Approvals.Verify(json);
    // First run creates .approved.txt file
    // Subsequent runs compare against it
}
```

---

## Checklist

- [ ] 70%+ unit tests (fast, isolated, many)
- [ ] 20% integration tests (API + database)
- [ ] 10% E2E tests (full workflows)
- [ ] AAA pattern (Arrange-Act-Assert)
- [ ] Descriptive test names (MethodName_Scenario_ExpectedBehavior)
- [ ] FluentAssertions for readability
- [ ] Mock dependencies with Moq
- [ ] TestContainers for real database tests
- [ ] WebApplicationFactory for API tests
- [ ] Test data builders for complex setup
- [ ] Code coverage > 80% on business logic
- [ ] Performance benchmarks for critical paths
- [ ] Tests run in < 5 seconds (unit), < 30 seconds (integration)

---

**Tests are documentation. They show how your code is meant to be used and prove it works.**