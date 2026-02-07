# EF Core Performance & Querying

Optimize Entity Framework Core for high-performance data access. Every query must be efficient, trackable, and production-ready.

---

## Query Optimization

### Projection Over Entities
```csharp
// DO - Project to DTOs
var users = await context.Users
    .Where(u => u.IsActive)
    .Select(u => new UserDto { Id = u.Id, Name = u.Name })
    .ToListAsync();

// AVOID - Loading full entities when only needing specific fields
var users = await context.Users.Where(u => u.IsActive).ToListAsync();
```

### No-Tracking for Read-Only Queries
```csharp
// DO - Use AsNoTracking for all read operations
var posts = await context.Posts
    .AsNoTracking()
    .Where(p => p.Published)
    .ToListAsync();

// AVOID - Tracking entities you won't modify
var posts = await context.Posts.Where(p => p.Published).ToListAsync();
```

### Avoid N+1 Queries
```csharp
// DO - Eager load with Include
var blogs = await context.Blogs
    .Include(b => b.Posts)
    .ToListAsync();

// BETTER - Project to avoid cartesian explosion
var blogs = await context.Blogs
    .Select(b => new { b.Name, Posts = b.Posts.Select(p => p.Title) })
    .ToListAsync();

// AVOID - Lazy loading causes N+1
foreach (var blog in await context.Blogs.ToListAsync())
{
    // Each iteration triggers a separate query
    var posts = blog.Posts;
}
```

---

## Split Queries

Use for large collections to avoid cartesian explosion:

```csharp
// DO - Split query for multiple collections
var blogs = await context.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Comments)
    .AsSplitQuery()
    .ToListAsync();

// Result: 3 queries instead of 1 massive JOIN
```

---

## Compiled Queries

For hot paths that execute frequently:

```csharp
// DO - Compile queries used in hot paths
private static readonly Func<ApplicationDbContext, int, Task<User>> _getUser =
    EF.CompileAsyncQuery((ApplicationDbContext ctx, int id) =>
        ctx.Users.FirstOrDefault(u => u.Id == id));

// Usage
var user = await _getUser(context, userId);
```

---

## Bulk Operations

EF Core 7+ native bulk operations:

```csharp
// DO - Use ExecuteUpdate/Delete for bulk operations
await context.Users
    .Where(u => u.IsActive == false)
    .ExecuteDeleteAsync();

await context.Posts
    .Where(p => p.PublishedDate < cutoffDate)
    .ExecuteUpdateAsync(s => s.SetProperty(p => p.IsArchived, true));

// AVOID - Loading entities just to delete them
var inactiveUsers = await context.Users.Where(u => !u.IsActive).ToListAsync();
context.Users.RemoveRange(inactiveUsers);
await context.SaveChangesAsync();
```

---

## Pagination

Always paginate large result sets:

```csharp
// DO - Use Skip/Take with total count
var query = context.Posts.Where(p => p.Published);
var totalCount = await query.CountAsync();
var posts = await query
    .OrderByDescending(p => p.CreatedDate)
    .Skip((pageNumber - 1) * pageSize)
    .Take(pageSize)
    .ToListAsync();

return new PagedResult<Post>(posts, totalCount, pageNumber, pageSize);
```

---

## Indexing

Define indexes for frequently queried columns:

```csharp
// In OnModelCreating
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<User>()
        .HasIndex(u => u.Email)
        .IsUnique();

    modelBuilder.Entity<Order>()
        .HasIndex(o => new { o.UserId, o.CreatedDate });

    // Filtered index for SQL Server
    modelBuilder.Entity<Post>()
        .HasIndex(p => p.Title)
        .HasFilter("[IsPublished] = 1");
}
```

---

## DbContext Configuration

```csharp
// DO - Use pooling for high-throughput scenarios
services.AddDbContextPool<ApplicationDbContext>(options =>
    options.UseSqlServer(connectionString)
        .EnableSensitiveDataLogging(isDevelopment) // Only in dev
        .EnableDetailedErrors(isDevelopment)); // Only in dev

// DO - Configure connection pooling in connection string
"Server=...;Max Pool Size=200;Min Pool Size=5;Pooling=true;"
```

---

## Query Filters

Define global query filters:

```csharp
// In OnModelCreating
modelBuilder.Entity<Post>()
    .HasQueryFilter("ActivePosts", p => !p.IsDeleted);

// Bypass when needed
var allPosts = await context.Posts
    .IgnoreQueryFilters(["ActivePosts"])
    .ToListAsync();
```

---

## JSON Columns

For semi-structured data (EF Core 7+):

```csharp
public class Product
{
    public int Id { get; init; }
    public ProductMetadata Metadata { get; init; } // JSON column
}

// In OnModelCreating
modelBuilder.Entity<Product>()
    .OwnsOne(p => p.Metadata, md => md.ToJson());

// Query JSON properties
var products = await context.Products
    .Where(p => EF.Property<string>(p.Metadata, "Brand") == "Acme")
    .ToListAsync();
```

---

## Performance Checklist

- [ ] All read-only queries use `.AsNoTracking()`
- [ ] Projections used instead of loading full entities
- [ ] No N+1 queries — verified with logging
- [ ] Split queries for multiple large collections
- [ ] Compiled queries for hot paths
- [ ] Bulk operations use `ExecuteUpdate/Delete`
- [ ] All list endpoints paginated
- [ ] Indexes defined for WHERE/ORDER BY columns
- [ ] DbContext pooling enabled
- [ ] Connection pooling configured
- [ ] Query filters applied where appropriate
- [ ] Async all the way — no `.Result` or `.Wait()`

---

**Measure before optimizing. Profile with SQL Server Profiler or EF Core logging. Your queries should complete in < 100ms.**