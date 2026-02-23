# Clean Architecture
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Dependencies point inward only — Domain has no dependencies, Application depends only on Domain, Infrastructure and API depend on Application. Never reverse this.

## Why This Kills You At Scale
When your Application layer references `Microsoft.EntityFrameworkCore`, you cannot swap your ORM, cannot unit test without a DB, and cannot run domain logic independently. At 100k users when SQL Server becomes a bottleneck and you want to introduce Redis or a read replica, every service that imported EF Core must be touched. The entire codebase becomes a single deployable unit where a change in one layer forces recompilation of everything.

## The Pattern

```csharp
#nullable enable

// ✅ Correct: project structure
// PutZige.Domain          → no external dependencies (no NuGet packages except primitives)
// PutZige.Application     → depends on Domain only, defines interfaces
// PutZige.Infrastructure  → depends on Application, implements interfaces (EF Core, Redis, etc.)
// PutZige.API             → depends on Application (not Infrastructure — uses DI)
// PutZige.Tests.Unit      → depends on Application (mocks Infrastructure)
// PutZige.Tests.Integration → depends on API + Infrastructure

// ✅ Correct: Domain layer — pure C#, zero dependencies
// Domain/Entities/Conversation.cs
namespace PutZige.Domain.Entities;

public sealed class Conversation
{
    public Guid Id { get; private set; } = Guid.NewGuid();
    public string Title { get; private set; } = string.Empty;
    public Guid UserId { get; private set; }
    public bool IsDeleted { get; private set; }
    private readonly List<Message> _messages = [];
    public IReadOnlyList<Message> Messages => _messages.AsReadOnly();

    // ✅ Domain logic lives here — not in services or controllers
    public void UpdateTitle(string newTitle)
    {
        if (string.IsNullOrWhiteSpace(newTitle))
            throw new ArgumentException("Title cannot be empty");
        Title = newTitle;
    }

    public static Conversation Create(string title, Guid userId)
        => new() { Title = title, UserId = userId };
}

// ✅ Correct: Application layer interface — defined here, implemented in Infrastructure
// Application/Interfaces/IConversationRepository.cs
namespace PutZige.Application.Interfaces;

public interface IConversationRepository
{
    Task<Conversation?> GetByIdAsync(Guid id, CancellationToken ct);
    Task<List<Conversation>> GetByUserIdAsync(Guid userId, CancellationToken ct);
    void Add(Conversation conversation);
}

// ✅ Correct: Application service — depends on interface, not implementation
// Application/Services/ConversationService.cs
namespace PutZige.Application.Services;

public sealed class ConversationService(
    IConversationRepository conversationRepository,
    IUnitOfWork unitOfWork,
    ICurrentUserService currentUser)
{
    public async Task<ConversationDto> CreateAsync(
        CreateConversationRequest request, CancellationToken ct)
    {
        var conversation = Conversation.Create(request.Title, currentUser.GetUserId());
        conversationRepository.Add(conversation);
        await unitOfWork.SaveChangesAsync(ct);
        return conversation.ToDto();
    }
}

// ✅ Correct: Infrastructure implementation — references EF Core, Application interface
// Infrastructure/Repositories/ConversationRepository.cs
namespace PutZige.Infrastructure.Repositories;

public sealed class ConversationRepository(AppDbContext context) : IConversationRepository
{
    public async Task<Conversation?> GetByIdAsync(Guid id, CancellationToken ct)
        => await context.Conversations.FirstOrDefaultAsync(c => c.Id == id, ct);

    public async Task<List<Conversation>> GetByUserIdAsync(Guid userId, CancellationToken ct)
        => await context.Conversations
            .AsNoTracking()
            .Where(c => c.UserId == userId)
            .ToListAsync(ct);

    public void Add(Conversation conversation) => context.Conversations.Add(conversation);
}

// ✅ Correct: API registration — API depends on Application interfaces, not Infrastructure types
// Program.cs
builder.Services.AddScoped<IConversationRepository, ConversationRepository>();
builder.Services.AddScoped<ConversationService>();
// The API project references Infrastructure for DI registration only
// No Infrastructure types are used anywhere in API layer except Program.cs

// ❌ Wrong: Application layer directly using EF Core
// Application/Services/ConversationService.cs
using Microsoft.EntityFrameworkCore; // ← This kills testability and replaceability

public class ConversationServiceBad(AppDbContext context) // ← Infrastructure dependency in Application
{
    public async Task<ConversationDto> CreateAsync(CreateConversationRequest req, CancellationToken ct)
    {
        var conversation = new Conversation { Title = req.Title };
        context.Conversations.Add(conversation); // ← EF Core in Application layer
        await context.SaveChangesAsync(ct);
        return conversation.ToDto();
    }
}
```

## The Trap

```csharp
// A senior developer sets up Clean Architecture correctly.
// Layer boundaries enforced. Ships.
// The trap: DTO mapping leaks domain entities to the API layer.

// Application service returns the domain entity
public async Task<Conversation> CreateAsync(CreateConversationRequest req, CancellationToken ct)
{
    var conversation = Conversation.Create(req.Title, _currentUser.GetUserId());
    _repo.Add(conversation);
    await _unitOfWork.SaveChangesAsync(ct);
    return conversation; // BUG: returns domain entity, not DTO
}

// Controller receives domain entity directly
public async Task<ActionResult<Conversation>> Create([FromBody] CreateConversationRequest req, CancellationToken ct)
{
    var conversation = await _conversationService.CreateAsync(req, ct);
    return Ok(conversation); // Domain entity serialized — exposes internal structure
    // EF Core navigation properties cause circular reference exceptions
    // Private setters cause serialization issues
    // Internal state (IsDeleted, timestamps) leaked to clients
}

// Fix: always return DTOs from Application layer — never domain entities
public async Task<ConversationDto> CreateAsync(CreateConversationRequest req, CancellationToken ct)
{
    var conversation = Conversation.Create(req.Title, _currentUser.GetUserId());
    _repo.Add(conversation);
    await _unitOfWork.SaveChangesAsync(ct);
    return conversation.ToDto(); // Map to DTO before leaving Application layer
}

// Define ToDto() as extension method in Application layer
public static class ConversationMappingExtensions
{
    public static ConversationDto ToDto(this Conversation c) => new()
    {
        Id = c.Id,
        Title = c.Title,
        UserId = c.UserId
    };
}
```

## The Exception
For very simple CRUD microservices with no domain logic (a configuration service, a feature flag store, a settings API), Clean Architecture adds ceremony without benefit. In these cases, a simple service that directly uses the DbContext in a controller is correct and maintainable. Apply Clean Architecture when there is meaningful business logic that benefits from isolation. Do not apply it dogmatically to every service.

## Before You Merge
- Does `PutZige.Domain.csproj` have zero NuGet package references except perhaps `System.*` primitives?
- Does `PutZige.Application.csproj` reference only `PutZige.Domain` — no Infrastructure, no API, no EF Core?
- Does `PutZige.API.csproj` reference `PutZige.Application` for its controllers and `PutZige.Infrastructure` only in `Program.cs` for DI registration?
- Do all Application service methods return DTOs — never domain entities?
- Is there an architecture test using `NetArchTest.Rules` or `ArchUnitNET` enforcing the dependency rules?
