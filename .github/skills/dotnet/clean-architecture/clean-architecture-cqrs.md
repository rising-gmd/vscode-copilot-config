# Clean Architecture & CQRS

Implement maintainable, testable enterprise applications. Every layer has a single responsibility, and dependencies flow inward.

---

## Layer Dependencies

```
API/Presentation Layer
       ↓ (depends on)
Application Layer
       ↓ (depends on)
Domain Layer
       ↑ (implements)
Infrastructure Layer
```

**Rule: Inner layers NEVER depend on outer layers.**

---

## Domain Layer

**Pure business logic. Zero dependencies on frameworks, databases, or external services.**

```csharp
// Entities
public class Order
{
    public int Id { get; private set; }
    public decimal Total { get; private set; }
    public OrderStatus Status { get; private set; }
    private readonly List<OrderItem> _items = new();
    public IReadOnlyList<OrderItem> Items => _items.AsReadOnly();

    private Order() { } // EF Core

    public static Order Create(int customerId)
    {
        return new Order
        {
            CustomerId = customerId,
            Status = OrderStatus.Pending,
            CreatedDate = DateTime.UtcNow
        };
    }

    public void AddItem(Product product, int quantity)
    {
        if (Status != OrderStatus.Pending)
            throw new InvalidOperationException("Cannot modify submitted order");

        var item = new OrderItem(product.Id, product.Price, quantity);
        _items.Add(item);
        Total += item.Subtotal;
    }

    public void Submit()
    {
        if (!_items.Any())
            throw new DomainException("Cannot submit empty order");

        Status = OrderStatus.Submitted;
        RaiseDomainEvent(new OrderSubmittedEvent(Id));
    }
}

// Value Objects
public record Address(string Street, string City, string State, string ZipCode);

public record Money(decimal Amount, string Currency)
{
    public Money Add(Money other)
    {
        if (Currency != other.Currency)
            throw new InvalidOperationException("Cannot add different currencies");
        return this with { Amount = Amount + other.Amount };
    }
}

// Domain Events
public record OrderSubmittedEvent(int OrderId);

// Exceptions
public class DomainException : Exception
{
    public DomainException(string message) : base(message) { }
}
```

---

## Application Layer

**Use cases, CQRS handlers, DTOs, interfaces. Orchestrates domain logic.**

### Commands (Writes)

```csharp
// Command
public record CreateOrderCommand(int CustomerId, List<OrderItemDto> Items) : IRequest<int>;

// Handler
public class CreateOrderCommandHandler : IRequestHandler<CreateOrderCommand, int>
{
    private readonly IOrderRepository _orderRepository;
    private readonly IProductRepository _productRepository;
    private readonly IUnitOfWork _unitOfWork;

    public CreateOrderCommandHandler(
        IOrderRepository orderRepository,
        IProductRepository productRepository,
        IUnitOfWork unitOfWork)
    {
        _orderRepository = orderRepository;
        _productRepository = productRepository;
        _unitOfWork = unitOfWork;
    }

    public async Task<int> Handle(CreateOrderCommand request, CancellationToken ct)
    {
        var order = Order.Create(request.CustomerId);

        foreach (var item in request.Items)
        {
            var product = await _productRepository.GetByIdAsync(item.ProductId, ct)
                ?? throw new NotFoundException($"Product {item.ProductId} not found");

            order.AddItem(product, item.Quantity);
        }

        await _orderRepository.AddAsync(order, ct);
        await _unitOfWork.SaveChangesAsync(ct);

        return order.Id;
    }
}

// Validator
public class CreateOrderCommandValidator : AbstractValidator<CreateOrderCommand>
{
    public CreateOrderCommandValidator()
    {
        RuleFor(x => x.CustomerId).GreaterThan(0);
        RuleFor(x => x.Items).NotEmpty();
        RuleForEach(x => x.Items).SetValidator(new OrderItemDtoValidator());
    }
}
```

### Queries (Reads)

```csharp
// Query
public record GetOrderByIdQuery(int OrderId) : IRequest<OrderDto?>;

// Handler
public class GetOrderByIdQueryHandler : IRequestHandler<GetOrderByIdQuery, OrderDto?>
{
    private readonly IOrderReadRepository _orderRepository;

    public GetOrderByIdQueryHandler(IOrderReadRepository orderRepository)
        => _orderRepository = orderRepository;

    public async Task<OrderDto?> Handle(GetOrderByIdQuery request, CancellationToken ct)
    {
        // Use Dapper or EF Core projections for optimal read performance
        return await _orderRepository.GetByIdAsync(request.OrderId, ct);
    }
}
```

---

## Infrastructure Layer

**Implements interfaces from Application layer. Database, external APIs, file system.**

```csharp
// Repository Implementation
public class OrderRepository : IOrderRepository
{
    private readonly ApplicationDbContext _context;

    public OrderRepository(ApplicationDbContext context) => _context = context;

    public async Task<Order?> GetByIdAsync(int id, CancellationToken ct)
    {
        return await _context.Orders
            .Include(o => o.Items)
            .FirstOrDefaultAsync(o => o.Id == id, ct);
    }

    public async Task AddAsync(Order order, CancellationToken ct)
    {
        await _context.Orders.AddAsync(order, ct);
    }
}

// Read Repository (Dapper for performance)
public class OrderReadRepository : IOrderReadRepository
{
    private readonly IDbConnection _connection;

    public OrderReadRepository(IDbConnection connection) => _connection = connection;

    public async Task<OrderDto?> GetByIdAsync(int id, CancellationToken ct)
    {
        var sql = """
            SELECT o.Id, o.Total, o.Status, o.CreatedDate,
                   oi.Id, oi.ProductId, oi.Quantity, oi.Price
            FROM Orders o
            LEFT JOIN OrderItems oi ON o.Id = oi.OrderId
            WHERE o.Id = @Id
            """;

        var orderDict = new Dictionary<int, OrderDto>();

        await _connection.QueryAsync<OrderDto, OrderItemDto, OrderDto>(
            sql,
            (order, item) =>
            {
                if (!orderDict.TryGetValue(order.Id, out var currentOrder))
                {
                    currentOrder = order;
                    currentOrder.Items = new List<OrderItemDto>();
                    orderDict.Add(order.Id, currentOrder);
                }
                if (item is not null)
                    currentOrder.Items.Add(item);
                return currentOrder;
            },
            new { Id = id },
            splitOn: "Id");

        return orderDict.Values.FirstOrDefault();
    }
}

// Unit of Work
public class UnitOfWork : IUnitOfWork
{
    private readonly ApplicationDbContext _context;

    public UnitOfWork(ApplicationDbContext context) => _context = context;

    public async Task<int> SaveChangesAsync(CancellationToken ct)
    {
        // Dispatch domain events before saving
        var domainEvents = _context.ChangeTracker
            .Entries<Entity>()
            .SelectMany(e => e.Entity.DomainEvents)
            .ToList();

        var result = await _context.SaveChangesAsync(ct);

        foreach (var domainEvent in domainEvents)
        {
            await _mediator.Publish(domainEvent, ct);
        }

        return result;
    }
}
```

---

## API/Presentation Layer

**Thin controllers/endpoints. Delegate to MediatR handlers.**

```csharp
// Minimal API
public static class OrderEndpoints
{
    public static RouteGroupBuilder MapOrderEndpoints(this RouteGroupBuilder group)
    {
        group.MapPost("/", CreateOrder)
            .Produces<int>(201)
            .ProducesValidationProblem();

        group.MapGet("/{id:int}", GetOrder)
            .Produces<OrderDto>(200)
            .ProducesProblem(404);

        return group;
    }

    private static async Task<Results<Created<int>, ValidationProblem>> CreateOrder(
        CreateOrderCommand command,
        ISender sender,
        CancellationToken ct)
    {
        var orderId = await sender.Send(command, ct);
        return TypedResults.Created($"/api/orders/{orderId}", orderId);
    }

    private static async Task<Results<Ok<OrderDto>, NotFound>> GetOrder(
        int id,
        ISender sender,
        CancellationToken ct)
    {
        var order = await sender.Send(new GetOrderByIdQuery(id), ct);
        return order is null ? TypedResults.NotFound() : TypedResults.Ok(order);
    }
}
```

---

## MediatR Pipeline Behaviors

Cross-cutting concerns as pipeline behaviors:

```csharp
// Validation
public class ValidationBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    private readonly IEnumerable<IValidator<TRequest>> _validators;

    public ValidationBehavior(IEnumerable<IValidator<TRequest>> validators)
        => _validators = validators;

    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        if (!_validators.Any()) return await next();

        var context = new ValidationContext<TRequest>(request);
        var validationResults = await Task.WhenAll(
            _validators.Select(v => v.ValidateAsync(context, ct)));

        var failures = validationResults
            .SelectMany(r => r.Errors)
            .Where(f => f != null)
            .ToList();

        if (failures.Any())
            throw new ValidationException(failures);

        return await next();
    }
}

// Logging
public class LoggingBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    private readonly ILogger<LoggingBehavior<TRequest, TResponse>> _logger;

    public LoggingBehavior(ILogger<LoggingBehavior<TRequest, TResponse>> logger)
        => _logger = logger;

    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        _logger.LogInformation("Handling {RequestName}", typeof(TRequest).Name);
        var response = await next();
        _logger.LogInformation("Handled {RequestName}", typeof(TRequest).Name);
        return response;
    }
}

// Transaction
public class TransactionBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    private readonly IUnitOfWork _unitOfWork;

    public TransactionBehavior(IUnitOfWork unitOfWork) => _unitOfWork = unitOfWork;

    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        // Only wrap commands in transactions (queries don't modify state)
        if (typeof(TRequest).Name.EndsWith("Query"))
            return await next();

        using var transaction = await _unitOfWork.BeginTransactionAsync(ct);
        try
        {
            var response = await next();
            await transaction.CommitAsync(ct);
            return response;
        }
        catch
        {
            await transaction.RollbackAsync(ct);
            throw;
        }
    }
}
```

---

## Dependency Registration

```csharp
// Program.cs
builder.Services.AddDomain();
builder.Services.AddApplication();
builder.Services.AddInfrastructure(builder.Configuration);

// Application/DependencyInjection.cs
public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddMediatR(cfg =>
        {
            cfg.RegisterServicesFromAssembly(Assembly.GetExecutingAssembly());
            cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
            cfg.AddOpenBehavior(typeof(LoggingBehavior<,>));
            cfg.AddOpenBehavior(typeof(TransactionBehavior<,>));
        });

        services.AddValidatorsFromAssembly(Assembly.GetExecutingAssembly());

        return services;
    }
}

// Infrastructure/DependencyInjection.cs
public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddDbContext<ApplicationDbContext>(options =>
            options.UseSqlServer(configuration.GetConnectionString("Default")));

        services.AddScoped<IOrderRepository, OrderRepository>();
        services.AddScoped<IOrderReadRepository, OrderReadRepository>();
        services.AddScoped<IUnitOfWork, UnitOfWork>();

        return services;
    }
}
```

---

## Architecture Tests

Enforce layer dependencies with NetArchTest:

```csharp
[Fact]
public void Domain_Should_Not_HaveDependencyOnOtherLayers()
{
    var result = Types.InAssembly(DomainAssembly)
        .Should()
        .NotHaveDependencyOnAll("Application", "Infrastructure", "API")
        .GetResult();

    Assert.True(result.IsSuccessful);
}

[Fact]
public void Application_Should_Not_HaveDependencyOnInfrastructure()
{
    var result = Types.InAssembly(ApplicationAssembly)
        .Should()
        .NotHaveDependencyOn("Infrastructure")
        .GetResult();

    Assert.True(result.IsSuccessful);
}

[Fact]
public void Handlers_Should_HaveCorrectNaming()
{
    var result = Types.InAssembly(ApplicationAssembly)
        .That()
        .ImplementInterface(typeof(IRequestHandler<,>))
        .Should()
        .HaveNameEndingWith("Handler")
        .GetResult();

    Assert.True(result.IsSuccessful);
}
```

---

## Checklist

- [ ] Domain layer has zero external dependencies
- [ ] Application layer defines interfaces, Infrastructure implements them
- [ ] Commands and Queries separated (CQRS)
- [ ] MediatR for request/response orchestration
- [ ] FluentValidation in pipeline behavior
- [ ] Unit of Work pattern for transactions
- [ ] Repository pattern abstracts data access
- [ ] DTOs for all application boundaries
- [ ] Architecture tests enforce layer rules
- [ ] Domain events for cross-aggregate communication

---

**Clean Architecture isn't overhead — it's survival. Your future self will thank you.**