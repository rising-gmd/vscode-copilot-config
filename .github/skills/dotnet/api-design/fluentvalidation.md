# FluentValidation
> Verified against: .NET 9 | C# 13 | FluentValidation 11.x | FluentValidation.AspNetCore 11.x
> Last reviewed: 2026-02-22

## The Law
Define one validator per request/command class, register validators via assembly scanning, and validate at the application boundary — never validate in controllers, services, or domain entities.

## Why This Kills You At Scale
Validation logic scattered across controllers, services, and domain models creates contradictory rules — a controller accepts a 500-char message, a service rejects it at 400 chars, and the DB column is 256 chars. At 100k users, inconsistent validation produces data corruption (values that pass the controller but fail at DB level), confusing error messages (service exceptions instead of validation responses), and untestable logic (validation tied to HTTP concerns).

## The Pattern

```csharp
#nullable enable
using FluentValidation;

// ✅ Correct: one validator per request class — in Application layer
public sealed class CreateMessageRequestValidator : AbstractValidator<CreateMessageRequest>
{
    public CreateMessageRequestValidator()
    {
        RuleFor(x => x.ConversationId)
            .NotEmpty()
            .WithMessage("Conversation ID is required")
            .WithErrorCode("CONVERSATION_ID_REQUIRED");

        RuleFor(x => x.Content)
            .NotEmpty()
            .WithMessage("Message content cannot be empty")
            .MaximumLength(4000)
            .WithMessage("Message content cannot exceed 4000 characters")
            .WithErrorCode("MESSAGE_TOO_LONG");

        // ✅ Conditional rule — only validate rich text content if flag is set
        When(x => x.IsRichText, () =>
        {
            RuleFor(x => x.Content)
                .Must(content => !content.Contains("<script", StringComparison.OrdinalIgnoreCase))
                .WithMessage("Rich text content contains disallowed tags");
        });
    }
}

public sealed class RegisterRequestValidator : AbstractValidator<RegisterRequest>
{
    private static readonly System.Text.RegularExpressions.Regex UsernameRegex =
        new(@"^[a-zA-Z0-9_]{3,30}$",
            System.Text.RegularExpressions.RegexOptions.Compiled,
            TimeSpan.FromMilliseconds(100)); // Timeout prevents ReDoS

    public RegisterRequestValidator(IUserRepository userRepository)
    {
        RuleFor(x => x.Email)
            .NotEmpty()
            .EmailAddress()
            .MaximumLength(256)
            .WithErrorCode("EMAIL_INVALID");

        RuleFor(x => x.Username)
            .NotEmpty()
            .Matches(UsernameRegex)
            .WithMessage("Username must be 3-30 characters: letters, numbers, underscore only")
            .WithErrorCode("USERNAME_INVALID")
            // ✅ Async rule — DB check runs after synchronous rules pass
            .MustAsync(async (username, ct) =>
                !await userRepository.ExistsByUsernameAsync(username, ct))
            .WithMessage("Username is already taken")
            .WithErrorCode("USERNAME_TAKEN");

        RuleFor(x => x.Password)
            .NotEmpty()
            .MinimumLength(8)
            .MaximumLength(128)
            .Matches(@"[A-Z]").WithMessage("Password must contain at least one uppercase letter")
            .Matches(@"[0-9]").WithMessage("Password must contain at least one number")
            .WithErrorCode("PASSWORD_INVALID");
    }
}

// ✅ Correct: register via assembly scanning in Program.cs
builder.Services.AddValidatorsFromAssembly(
    typeof(Application.AssemblyMarker).Assembly,
    lifetime: ServiceLifetime.Scoped);

// ✅ Correct: FluentValidation integrated with ASP.NET Core model validation
builder.Services.AddFluentValidationAutoValidation();
// Validation runs automatically before controller action — controller action not called if invalid

// ✅ Correct: manual validation in application service (for commands not coming via HTTP)
public sealed class MessageService(IValidator<CreateMessageRequest> validator)
{
    public async Task<MessageDto> CreateAsync(CreateMessageRequest request, CancellationToken ct)
    {
        // ✅ Validate at service entry — works for both HTTP and non-HTTP callers
        var validationResult = await validator.ValidateAsync(request, ct);
        if (!validationResult.IsValid)
            throw new ValidationException(validationResult.Errors);
        // ... proceed
    }
}

// ❌ Wrong: validation in controller
[HttpPost]
public async Task<IActionResult> Create([FromBody] CreateMessageRequest request)
{
    if (string.IsNullOrEmpty(request.Content)) // Validation in controller
        return BadRequest("Content required");
    if (request.Content.Length > 4000)         // Business rule in controller
        return BadRequest("Too long");
    // ...
}
```

## The Trap

```csharp
// A senior developer sets up FluentValidation with assembly scanning.
// Validators registered. Auto-validation enabled. Ships.
// The trap: async validators (.MustAsync) are NOT executed during model binding.
// AddFluentValidationAutoValidation runs synchronous validators automatically.
// Async validators require explicit async validation or a MediatR pipeline behavior.

// ❌ Wrong: expecting DB uniqueness check to run automatically
public sealed class RegisterRequestValidator : AbstractValidator<RegisterRequest>
{
    public RegisterRequestValidator(IUserRepository repo)
    {
        RuleFor(x => x.Email)
            .MustAsync(async (email, ct) => !await repo.ExistsByEmailAsync(email, ct))
            .WithMessage("Email already registered");
        // BUG: With AddFluentValidationAutoValidation(), async rules run synchronously
        // via GetAwaiter().GetResult() which can deadlock in some contexts
    }
}

// Fix 1: explicit async validation in service — not relying on auto-validation for async rules
// Fix 2: MediatR pipeline behavior that calls ValidateAsync before handler

public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    public async Task<TResponse> Handle(
        TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken ct)
    {
        if (!validators.Any()) return await next();

        var context = new ValidationContext<TRequest>(request);
        var results = await Task.WhenAll(
            validators.Select(v => v.ValidateAsync(context, ct)));

        var failures = results
            .SelectMany(r => r.Errors)
            .Where(f => f is not null)
            .ToList();

        if (failures.Count > 0)
            throw new ValidationException(failures);

        return await next();
    }
}
```

## The Exception
Domain entities may contain invariant checks (guards) that are not FluentValidation — these are enforced at object construction and cannot be bypassed. For example, a `Money` value object that throws `ArgumentOutOfRangeException` for negative amounts is correct — it is a domain invariant, not a request validation rule. FluentValidation validates external input (API requests, commands). Domain guards validate internal consistency (entity construction). Both are necessary and complementary.

## Before You Merge
- Is there exactly one `AbstractValidator<T>` per request/command class — no validation in controllers or services?
- Are validators registered via `AddValidatorsFromAssembly` — not one-by-one?
- Do async validators (DB uniqueness checks) run via a MediatR pipeline behavior or explicit `ValidateAsync` — not relying on `AddFluentValidationAutoValidation` for async rules?
- Does every rule have a `WithErrorCode` — not just `WithMessage` — so the Angular client can react to specific error codes?
- Are regex patterns compiled (`RegexOptions.Compiled`) and have a timeout to prevent ReDoS attacks?
