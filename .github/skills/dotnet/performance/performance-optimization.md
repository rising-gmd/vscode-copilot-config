# Performance Optimization

Every millisecond matters. Optimize relentlessly, measure constantly, and never guess.

---

## Async All the Way

```csharp
// DO - Async from top to bottom
public async Task<ActionResult<User>> GetUser(int id, CancellationToken ct)
{
    var user = await _userService.GetByIdAsync(id, ct);
    return user is null ? NotFound() : Ok(user);
}

public async Task<User?> GetByIdAsync(int id, CancellationToken ct)
{
    return await _repository.GetByIdAsync(id, ct);
}

public async Task<User?> GetByIdAsync(int id, CancellationToken ct)
{
    return await _context.Users.FindAsync(new object[] { id }, ct);
}

// NEVER - Blocking on async
var user = _userService.GetByIdAsync(id, default).Result; // Deadlock risk
var user = _userService.GetByIdAsync(id, default).GetAwaiter().GetResult(); // Still wrong
```

---

## Response Caching

```csharp
// Program.cs
builder.Services.AddResponseCaching();
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(builder => builder.Expire(TimeSpan.FromSeconds(60)));
    options.AddPolicy("ProductsCache", builder =>
        builder.Expire(TimeSpan.FromMinutes(5))
            .SetVaryByQuery("category", "page"));
});

app.UseResponseCaching();
app.UseOutputCache();

// On endpoints
[ResponseCache(Duration = 60, VaryByQueryKeys = new[] { "page" })]
public async Task<IActionResult> GetProducts(int page) { }

// Or Minimal APIs
app.MapGet("/products", GetProducts)
    .CacheOutput("ProductsCache");

// Cache tags for invalidation
app.MapGet("/products/{id}", GetProduct)
    .CacheOutput(policy => policy.Tag("products"));

// Invalidate cache
await outputCacheStore.EvictByTagAsync("products", ct);
```

---

## In-Memory Caching

```csharp
public class ProductService
{
    private readonly IMemoryCache _cache;
    private readonly IProductRepository _repository;

    public ProductService(IMemoryCache cache, IProductRepository repository)
    {
        _cache = cache;
        _repository = repository;
    }

    public async Task<Product?> GetByIdAsync(int id, CancellationToken ct)
    {
        var cacheKey = $"product:{id}";

        // Try get from cache
        if (_cache.TryGetValue(cacheKey, out Product? product))
            return product;

        // Cache miss - fetch from database
        product = await _repository.GetByIdAsync(id, ct);
        
        if (product is null)
            return null;

        // Cache with sliding expiration
        _cache.Set(cacheKey, product, new MemoryCacheEntryOptions
        {
            SlidingExpiration = TimeSpan.FromMinutes(5),
            Priority = CacheItemPriority.Normal
        });

        return product;
    }

    public async Task InvalidateCacheAsync(int id)
    {
        _cache.Remove($"product:{id}");
    }
}
```

---

## Distributed Caching (Redis)

```csharp
// Program.cs
builder.Services.AddStackExchangeRedisCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "MyApp:";
});

// Service
public class ProductService
{
    private readonly IDistributedCache _cache;
    private readonly IProductRepository _repository;

    public async Task<Product?> GetByIdAsync(int id, CancellationToken ct)
    {
        var cacheKey = $"product:{id}";

        // Try get from Redis
        var cachedJson = await _cache.GetStringAsync(cacheKey, ct);
        if (cachedJson is not null)
            return JsonSerializer.Deserialize<Product>(cachedJson);

        // Fetch from database
        var product = await _repository.GetByIdAsync(id, ct);
        if (product is null)
            return null;

        // Store in Redis with expiration
        var options = new DistributedCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(10)
        };
        await _cache.SetStringAsync(
            cacheKey,
            JsonSerializer.Serialize(product),
            options,
            ct);

        return product;
    }
}
```

---

## HybridCache (.NET 9+)

```csharp
// Combines in-memory + distributed cache
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024; // 1 MB
    options.MaximumKeyLength = 512;
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),
        LocalCacheExpiration = TimeSpan.FromMinutes(1)
    };
});

public class ProductService
{
    private readonly HybridCache _cache;

    public async Task<Product?> GetByIdAsync(int id, CancellationToken ct)
    {
        return await _cache.GetOrCreateAsync(
            $"product:{id}",
            async cancel => await _repository.GetByIdAsync(id, cancel),
            cancellationToken: ct);
    }

    public async Task InvalidateAsync(int id, CancellationToken ct)
    {
        await _cache.RemoveAsync($"product:{id}", ct);
    }
}
```

---

## Connection Pooling

```csharp
// DO - Enable connection pooling (default)
"Server=localhost;Database=MyDb;Trusted_Connection=true;Max Pool Size=200;Min Pool Size=5;Pooling=true"

// DO - Use DbContext pooling for high throughput
builder.Services.AddDbContextPool<ApplicationDbContext>(options =>
    options.UseSqlServer(connectionString),
    poolSize: 128);

// AVOID - Creating DbContext manually
using var context = new ApplicationDbContext(); // Bypasses pooling
```

---

## Span<T> and Memory<T>

```csharp
// DO - Use Span<T> for zero-allocation string parsing
public static int ParseInt(ReadOnlySpan<char> input)
{
    return int.Parse(input);
}

// Usage
var text = "Price: 123.45";
var priceSpan = text.AsSpan(7, 6); // "123.45" without allocating substring
var price = decimal.Parse(priceSpan);

// DO - Use stackalloc for small buffers
Span<byte> buffer = stackalloc byte[256];
var bytesRead = await stream.ReadAsync(buffer, ct);

// AVOID - Heap allocations for temporary buffers
var buffer = new byte[256]; // Allocates on heap
```

---

## ArrayPool<T>

```csharp
// DO - Rent from pool for large temporary arrays
var pool = ArrayPool<byte>.Shared;
var buffer = pool.Rent(minimumLength: 4096);
try
{
    var bytesRead = await stream.ReadAsync(buffer.AsMemory(0, 4096), ct);
    // Process buffer
}
finally
{
    pool.Return(buffer, clearArray: true);
}

// AVOID - Allocating large arrays repeatedly
for (int i = 0; i < 1000; i++)
{
    var buffer = new byte[4096]; // 1000 allocations
}
```

---

## Lazy<T> for Expensive Initialization

```csharp
public class ExpensiveService
{
    private readonly Lazy<ComplexObject> _expensiveObject = new(() =>
    {
        // Heavy computation/initialization
        return new ComplexObject();
    });

    public void UseObject()
    {
        var obj = _expensiveObject.Value; // Created only on first access
    }
}
```

---

## Minimal Allocations in Hot Paths

```csharp
// DO - Avoid allocations in loops
public decimal CalculateTotal(List<OrderItem> items)
{
    decimal total = 0;
    foreach (var item in items) // No allocation
    {
        total += item.Price * item.Quantity;
    }
    return total;
}

// AVOID - LINQ allocates enumerators
public decimal CalculateTotal(List<OrderItem> items)
{
    return items.Sum(i => i.Price * i.Quantity); // Allocates
}

// DO - StringBuilder for string concatenation
var sb = new StringBuilder();
foreach (var item in items)
{
    sb.AppendLine(item.ToString());
}
return sb.ToString();

// AVOID - String concatenation in loops
string result = "";
foreach (var item in items)
{
    result += item.ToString(); // Allocates new string each iteration
}
```

---

## Compression

```csharp
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
        new[] { "application/json" });
});

builder.Services.Configure<BrotliCompressionProviderOptions>(options =>
{
    options.Level = CompressionLevel.Fastest; // Balance speed vs ratio
});

app.UseResponseCompression();
```

---

## Minimal APIs Performance

```csharp
// DO - Minimal APIs are faster than controllers
app.MapGet("/users/{id:int}",
    async (int id, IUserService service, CancellationToken ct) =>
    {
        var user = await service.GetByIdAsync(id, ct);
        return user is null ? Results.NotFound() : Results.Ok(user);
    });

// Explicit result types reduce allocations
app.MapGet("/users/{id:int}",
    async Task<Results<Ok<UserDto>, NotFound>> (int id, IUserService service, CancellationToken ct) =>
    {
        var user = await service.GetByIdAsync(id, ct);
        return user is null ? TypedResults.NotFound() : TypedResults.Ok(user);
    });
```

---

## HTTP Client Best Practices

```csharp
// DO - Use IHttpClientFactory
builder.Services.AddHttpClient("ExternalApi", client =>
{
    client.BaseAddress = new Uri("https://api.example.com");
    client.DefaultRequestHeaders.Add("Accept", "application/json");
    client.Timeout = TimeSpan.FromSeconds(30);
});

// With Polly for resilience
builder.Services.AddHttpClient("ExternalApi")
    .AddTransientHttpErrorPolicy(policy =>
        policy.WaitAndRetryAsync(3, retryAttempt =>
            TimeSpan.FromSeconds(Math.Pow(2, retryAttempt))));

// Usage
public class ExternalApiService
{
    private readonly HttpClient _httpClient;

    public ExternalApiService(IHttpClientFactory httpClientFactory)
    {
        _httpClient = httpClientFactory.CreateClient("ExternalApi");
    }
}

// NEVER - New HttpClient per request
public async Task CallApi()
{
    using var client = new HttpClient(); // Port exhaustion
    var response = await client.GetAsync("https://api.example.com");
}
```

---

## Profiling & Diagnostics

```bash
# dotnet-counters - Real-time metrics
dotnet tool install -g dotnet-counters
dotnet-counters monitor -p <PID> --counters System.Runtime,Microsoft.AspNetCore.Hosting

# dotnet-trace - Performance traces
dotnet tool install -g dotnet-trace
dotnet-trace collect -p <PID> --providers Microsoft-DotNETCore-SampleProfiler

# dotnet-dump - Memory dumps
dotnet tool install -g dotnet-dump
dotnet-dump collect -p <PID>
dotnet-dump analyze <dump-file>

# BenchmarkDotNet - Micro-benchmarks
dotnet add package BenchmarkDotNet
dotnet run -c Release
```

---

## Metrics & Monitoring

```csharp
// Program.cs
builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics =>
    {
        metrics.AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddRuntimeInstrumentation();
    });

// Custom metrics
public class OrderService
{
    private static readonly Counter<int> _ordersCreated = 
        Meter.CreateCounter<int>("orders_created", "Orders");

    public async Task<int> CreateOrderAsync(CreateOrderCommand command, CancellationToken ct)
    {
        var orderId = await _repository.AddAsync(order, ct);
        _ordersCreated.Add(1, new KeyValuePair<string, object>("customer_id", command.CustomerId));
        return orderId;
    }
}
```

---

## Checklist

- [ ] Async all the way (no .Result or .Wait)
- [ ] Response caching on read endpoints
- [ ] In-memory or distributed cache for expensive queries
- [ ] Connection pooling enabled
- [ ] DbContext pooling for high throughput
- [ ] Span<T>/Memory<T> in hot paths
- [ ] ArrayPool for large temporary buffers
- [ ] Minimal allocations (StringBuilder, foreach over LINQ)
- [ ] Response compression (Brotli/Gzip)
- [ ] IHttpClientFactory (not new HttpClient)
- [ ] Profiled with dotnet-counters/dotnet-trace
- [ ] Metrics exported to monitoring system
- [ ] Benchmarks for critical paths
- [ ] Database queries optimized (indexed, projected)

---

**Performance is a feature. Measure, optimize, repeat.**