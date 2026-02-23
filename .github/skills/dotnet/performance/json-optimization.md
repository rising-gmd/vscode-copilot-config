# JSON Serialization Optimization
> Verified against: .NET 9 | C# 13 | System.Text.Json 9.x
> Last reviewed: 2026-02-22

## The Law
Use System.Text.Json source generation for all hot-path serialization — never Newtonsoft.Json on the request/response path, and never reflection-based serialization under sustained billion-user load.

## Why This Kills You At Scale
At one billion users, a chat API serializing 50 billion messages per day using reflection-based JSON is performing 50 billion runtime type inspections, each one walking property lists, checking attributes, and allocating intermediate objects. System.Text.Json with source generation generates the serialization code at compile time — zero reflection, zero runtime type inspection, 3-5x faster throughput, 60% less memory per serialization operation. At billion-user scale, this is the difference between needing 200 pods and needing 50.

## The Pattern

```csharp
#nullable enable
using System.Text.Json;
using System.Text.Json.Serialization;

// ✅ Correct: source generation context — one per bounded area
// Compile-time code generation — no reflection at runtime
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = false,              // Never pretty-print in production — wastes bytes
    GenerationMode = JsonSourceGenerationMode.Serialization)] // Serialize only — no reflection
[JsonSerializable(typeof(ApiResponse<MessageDto>))]
[JsonSerializable(typeof(ApiResponse<ConversationDto>))]
[JsonSerializable(typeof(ApiResponse<UserDto>))]
[JsonSerializable(typeof(ApiResponse<PagedResult<MessageDto>>))]
[JsonSerializable(typeof(ApiResponse<PagedResult<ConversationSummaryDto>>))]
[JsonSerializable(typeof(IReadOnlyList<EmojiDto>))]
[JsonSerializable(typeof(ProblemDetails))]
internal sealed partial class AppJsonContext : JsonSerializerContext { }

// ✅ Correct: register in ASP.NET Core — source-generated serializer for all endpoints
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
});

// Also apply to controllers:
builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
        options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        options.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        options.JsonSerializerOptions.Converters.Add(
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    });

// ✅ Correct: DTO design for optimal JSON performance
// Records are ideal — immutable, value semantics, compile-time safety
public sealed record MessageDto(
    Guid Id,
    string Content,
    Guid SenderId,
    string SenderUsername,
    DateTime SentAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? SenderProfilePicture,
    [property: JsonConverter(typeof(JsonStringEnumConverter))]
    DeliveryStatus Status);

// ✅ Correct: Utf8JsonWriter for hand-crafted high-performance serialization
// Used for streaming scenarios where source-gen is not available
public sealed class StreamingMessageSerializer
{
    private static readonly JsonWriterOptions _writerOptions = new()
    {
        SkipValidation = true, // Trust our own output — skip UTF-8 validation
        Indented = false
    };

    public async Task WriteMessagesAsync(
        IAsyncEnumerable<Message> messages,
        Stream outputStream,
        CancellationToken ct)
    {
        using var writer = new Utf8JsonWriter(outputStream, _writerOptions);
        writer.WriteStartArray();

        await foreach (var message in messages.WithCancellation(ct))
        {
            writer.WriteStartObject();
            writer.WriteString("id", message.Id);
            writer.WriteString("content", message.Content);
            writer.WriteString("senderId", message.SenderId);
            writer.WriteString("sentAt",
                message.SentAt.ToString("O")); // ISO 8601 — one allocation
            writer.WriteEndObject();

            // Flush periodically — don't buffer entire response
            if (writer.BytesPending > 64 * 1024) // 64KB chunks
            {
                await writer.FlushAsync(ct);
            }
        }

        writer.WriteEndArray();
        await writer.FlushAsync(ct);
    }
}

// ✅ Correct: JsonElement for pass-through JSON — never deserialize what you re-serialize
// If you receive JSON from an external API and must forward it, don't deserialize + reserialize
public sealed class WebhookForwardingService
{
    public async Task ForwardAsync(
        JsonDocument inboundPayload,
        HttpClient destination,
        CancellationToken ct)
    {
        // ✅ JsonDocument wraps the raw bytes — pass-through without deserialization cost
        var content = new StringContent(
            inboundPayload.RootElement.GetRawText(),
            Encoding.UTF8,
            "application/json");

        await destination.PostAsync("/webhook", content, ct);
    }
}

// ✅ Correct: custom JsonConverter for types not handled by source-gen
public sealed class UtcDateTimeConverter : JsonConverter<DateTime>
{
    public override DateTime Read(
        ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        var value = reader.GetDateTime();
        // Normalise to UTC — prevent timezone confusion at global scale
        return value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();
    }

    public override void Write(
        Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options)
    {
        // Always write UTC in ISO 8601 with Z suffix — never local time to API clients
        writer.WriteStringValue(
            DateTime.SpecifyKind(value, DateTimeKind.Utc).ToString("O"));
    }
}

// ❌ Wrong: Newtonsoft.Json on hot path — reflection, allocation, 5x slower
using Newtonsoft.Json; // Remove from hot-path code entirely
var json = JsonConvert.SerializeObject(dto); // Reflection per call

// ❌ Wrong: JsonSerializer.Serialize without source context — reflection-based
var json = JsonSerializer.Serialize(dto); // Falls back to reflection if type not in context
```

## The Trap

```csharp
// A senior developer correctly implements source generation context.
// All DTOs registered. Ships.
// The trap: adding a new DTO and forgetting to register it in the context.

// New endpoint added:
[HttpGet("reactions")]
public async Task<IActionResult> GetReactions(Guid messageId, CancellationToken ct)
{
    var reactions = await _service.GetReactionsAsync(messageId, ct);
    return Ok(ApiResponse.Ok(reactions)); // ApiResponse<IReadOnlyList<ReactionDto>>
}

// ReactionDto is NOT in AppJsonContext.
// System.Text.Json falls back to reflection — silently.
// No exception. No error. But this endpoint is 5x slower than all others.
// Discovered six months later when this endpoint shows 300ms p95 in APM
// while all others show 20ms. "Why is reactions slow?" is a mystery for two weeks.

// Fix: CI/CD validation that no response type escapes source generation.
// Add a test:
[Fact]
public void AllApiResponses_AreRegisteredInJsonContext()
{
    var assembly = typeof(AppJsonContext).Assembly;
    var controllers = assembly.GetTypes()
        .Where(t => t.IsAssignableTo(typeof(ControllerBase)));

    var returnTypes = controllers
        .SelectMany(c => c.GetMethods())
        .Where(m => m.GetCustomAttribute<HttpGetAttribute>() is not null
                 || m.GetCustomAttribute<HttpPostAttribute>() is not null)
        .Select(m => m.ReturnType)
        .Where(t => t.IsGenericType)
        .ToList();

    // Verify each return type has a JsonTypeInfo in AppJsonContext.Default
    foreach (var type in returnTypes)
    {
        var info = AppJsonContext.Default.GetTypeInfo(type);
        Assert.NotNull(info); // Fails fast if any type is missing from context
    }
}
```

## The Exception
Newtonsoft.Json is acceptable for: (1) complex polymorphic serialization with discriminators that System.Text.Json source generation cannot express, (2) legacy integration with third-party libraries that hard-code Newtonsoft (SignalR v2 MessagePack, older Azure SDK versions), (3) admin/tooling endpoints called infrequently where reflection cost is irrelevant. The rule applies to every endpoint in the hot path — user-facing API responses under sustained load. Newtonsoft on cold admin paths is a pragmatic trade-off, not a defect.

## Before You Merge
- Is every DTO used in a controller response registered in `AppJsonContext` — verified by the type-registration test?
- Is `WriteIndented = false` set globally — no pretty-printing in production?
- Is `JsonIgnoreCondition.WhenWritingNull` set globally — null fields excluded from serialized output?
- Are `DateTime` values always serialized in UTC ISO 8601 (`"O"` format with `Z` suffix) — never local time or culture-specific format?
- Is Newtonsoft.Json absent from the hot-path project references — verified in `csproj` and `nuget.lock`?
