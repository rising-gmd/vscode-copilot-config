# Memory Management
> Verified against: .NET 9 | C# 13 | ASP.NET Core 9.x
> Last reviewed: 2026-02-22

## The Law
Eliminate allocations on hot paths — use `ArrayPool<T>`, `MemoryPool<T>`, `Span<T>`, `stackalloc`, and object pooling to prevent the GC from becoming the bottleneck on billion-user throughput.

## Why This Kills You At Scale
At one billion users, a chat endpoint that allocates a 4KB `byte[]` per request to serialize a JSON payload allocates 4TB of heap memory per day. The GC runs Gen2 collections constantly, stopping threads for tens of milliseconds on every collection. Throughput collapses. P99 latency spikes to seconds while the GC cleans up garbage that did not need to exist. The CPU is spending 30-40% of its time collecting garbage instead of serving requests. Every allocation you eliminate on the hot path directly improves throughput and reduces GC pressure.

## The Pattern

```csharp
#nullable enable
using System.Buffers;
using System.Runtime.InteropServices;
using Microsoft.IO;

// ✅ Correct: RecyclableMemoryStream — eliminates MemoryStream allocation on hot paths
// Regular MemoryStream allocates exponentially — 256B → 512B → 1KB → 2KB as it grows
// RecyclableMemoryStream reuses pooled buffers — zero allocations on resize
public sealed class JsonSerializationService
{
    // ✅ Singleton — shared pool across all requests
    private static readonly RecyclableMemoryStreamManager _streamManager =
        new(new RecyclableMemoryStreamManager.Options
        {
            BlockSize = 4096,
            LargeBufferMultiple = 1024 * 1024,
            MaximumBufferSize = 128 * 1024 * 1024,
        });

    private static readonly JsonSerializerOptions _options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task SerializeToResponseAsync<T>(
        T value,
        HttpResponse response,
        CancellationToken ct)
    {
        response.ContentType = "application/json";

        // ✅ Pooled stream — returned to pool after use, not GC'd
        using var stream = _streamManager.GetStream();
        await JsonSerializer.SerializeAsync(stream, value, _options, ct);
        stream.Seek(0, SeekOrigin.Begin);
        await stream.CopyToAsync(response.Body, ct);
    }
}

// ✅ Correct: ArrayPool<T> for temporary buffers — eliminates byte[] allocation
public sealed class MessageHashService
{
    public bool VerifySignature(
        ReadOnlySpan<byte> payload,
        ReadOnlySpan<byte> signature,
        byte[] key)
    {
        // ✅ Rent from pool — no heap allocation
        var buffer = ArrayPool<byte>.Shared.Rent(payload.Length + 32);
        try
        {
            // Work with Span — no additional allocation
            var workArea = buffer.AsSpan(0, payload.Length + 32);
            payload.CopyTo(workArea);

            using var hmac = new HMACSHA256(key);
            Span<byte> computed = stackalloc byte[32]; // Stack allocation — 32 bytes
            hmac.TryComputeHash(payload, computed, out _);

            return CryptographicOperations.FixedTimeEquals(computed, signature);
        }
        finally
        {
            // ✅ Must always return to pool — even if exception thrown
            ArrayPool<byte>.Shared.Return(buffer, clearArray: true); // Clear sensitive data
        }
    }
}

// ✅ Correct: ObjectPool<T> for expensive-to-create objects
// StringBuilder, SHA256, complex domain objects — reuse across requests
public sealed class MessageFormatterService
{
    // ✅ Shared pool — DefaultObjectPoolProvider manages max size
    private static readonly ObjectPool<StringBuilder> _sbPool =
        new DefaultObjectPoolProvider().CreateStringBuilderPool(
            initialCapacity: 256,
            maximumRetainedCapacity: 4096);

    public string FormatNotification(string senderName, string preview, string conversationName)
    {
        var sb = _sbPool.Get();
        try
        {
            sb.Append(senderName)
              .Append(" in ")
              .Append(conversationName)
              .Append(": ")
              .Append(preview.Length > 100 ? preview.AsSpan(0, 100) : preview.AsSpan())
              .Append("...");

            return sb.ToString();
        }
        finally
        {
            _sbPool.Return(sb); // Clears and returns to pool
        }
    }
}

// ✅ Correct: Span<T> for string parsing — zero allocation
public static class MessageContentParser
{
    // Parse "@username" mentions from message content — no substring allocation
    public static IReadOnlyList<ReadOnlyMemory<char>> ExtractMentions(
        ReadOnlyMemory<char> content)
    {
        var mentions = new List<ReadOnlyMemory<char>>();
        var span = content.Span;
        var start = -1;

        for (var i = 0; i < span.Length; i++)
        {
            if (span[i] == '@')
            {
                start = i + 1; // Start of username after @
            }
            else if (start >= 0 && !char.IsLetterOrDigit(span[i]) && span[i] != '_')
            {
                if (i > start)
                    mentions.Add(content.Slice(start, i - start)); // No string allocation
                start = -1;
            }
        }

        if (start >= 0 && start < content.Length)
            mentions.Add(content.Slice(start)); // Trailing mention

        return mentions;
    }
}

// ✅ Correct: stackalloc for small, short-lived buffers
public static class GuidParser
{
    public static bool TryParseFromPath(
        ReadOnlySpan<char> path,
        out Guid result)
    {
        // ✅ 36 chars for a GUID — stack allocated, never touches heap
        Span<char> buffer = stackalloc char[36];
        if (path.Length < 36)
        {
            result = default;
            return false;
        }
        path[..36].CopyTo(buffer);
        return Guid.TryParse(buffer, out result);
    }
}

// ✅ Correct: IDisposable with pooled resources — explicit resource return
public sealed class PooledMessageBuilder : IDisposable
{
    private static readonly ObjectPool<PooledMessageBuilder> _pool =
        new DefaultObjectPoolProvider().Create(new PooledMessageBuilderPolicy());

    private readonly StringBuilder _sb = new();
    private bool _returned;

    public static PooledMessageBuilder Get() => _pool.Get();

    public PooledMessageBuilder Append(string value) { _sb.Append(value); return this; }
    public override string ToString() => _sb.ToString();

    public void Dispose()
    {
        if (!_returned)
        {
            _returned = true;
            _sb.Clear();
            _pool.Return(this);
        }
    }
}

// ❌ Wrong: new byte[] on hot path — GC pressure at scale
public byte[] SerializeWrong(MessageDto msg)
{
    return JsonSerializer.SerializeToUtf8Bytes(msg); // New byte[] every call
}

// ❌ Wrong: LINQ on hot path — multiple enumerator allocations
public MessageDto? FindLatestWrong(IEnumerable<Message> messages)
{
    // Creates IOrderedEnumerable, IEnumerator, and intermediate objects
    return messages.OrderByDescending(m => m.SentAt).FirstOrDefault()?.ToDto();
}

// ✅ Correct hot-path version: manual loop — zero LINQ allocation
public MessageDto? FindLatest(List<Message> messages)
{
    if (messages.Count == 0) return null;
    var latest = messages[0];
    for (var i = 1; i < messages.Count; i++)
        if (messages[i].SentAt > latest.SentAt) latest = messages[i];
    return latest.ToDto();
}
```

## The Trap

```csharp
// A senior developer correctly uses ArrayPool, ObjectPool, RecyclableMemoryStream.
// GC pressure drops dramatically. Ships.
// The trap: forgetting to return pooled objects — produces memory leaks worse than GC.

// ArrayPool<T>.Rent() returns an array that MUST be returned via ArrayPool.Return().
// If an exception is thrown before Return(), the array is leaked from the pool.
// The pool doesn't grow — it has a fixed max size. Subsequent Rent() calls
// allocate new arrays from the heap without returning them.
// Net result: more heap allocation than if you'd never used the pool.
// Plus the pool is exhausted and subsequent operations degrade.

// ❌ Wrong: no try/finally — leak on exception
public void ProcessWrong(ReadOnlySpan<byte> data)
{
    var buffer = ArrayPool<byte>.Shared.Rent(data.Length);
    data.CopyTo(buffer);
    ProcessBuffer(buffer); // If this throws, Return() never called — leak
    ArrayPool<byte>.Shared.Return(buffer);
}

// ✅ Correct: always try/finally with pooled resources
public void ProcessCorrect(ReadOnlySpan<byte> data)
{
    var buffer = ArrayPool<byte>.Shared.Rent(data.Length);
    try
    {
        data.CopyTo(buffer.AsSpan(0, data.Length));
        ProcessBuffer(buffer.AsSpan(0, data.Length));
    }
    finally
    {
        // Guaranteed execution — exception or not
        ArrayPool<byte>.Shared.Return(buffer, clearArray: false);
    }
}

// ✅ Correct: IMemoryOwner<T> — Dispose() returns automatically (safer pattern)
public void ProcessWithOwner(ReadOnlySpan<byte> data)
{
    using IMemoryOwner<byte> owner = MemoryPool<byte>.Shared.Rent(data.Length);
    var buffer = owner.Memory.Span[..data.Length];
    data.CopyTo(buffer);
    ProcessBuffer(buffer); // Dispose() via using — always returned
}
```

## The Exception
Cold paths — error handling, startup configuration, admin operations, one-time initialization — do not need pool-based allocation. The investment in pooling pays off only on paths executed millions of times per second. Profile with dotMemory, PerfView, or `dotnet-trace` before optimizing — allocations that appear hot in a code review may be cold in production profiling. Never optimize allocation on paths not confirmed hot by profiler data.

## Before You Merge
- Are `ArrayPool<byte>.Shared.Return()` calls inside `try/finally` blocks — never outside?
- Are hot-path buffer operations using `IMemoryOwner<T>` with `using` — to guarantee pool return via Dispose?
- Is `RecyclableMemoryStreamManager` a singleton — not instantiated per request?
- Are LINQ operators (`OrderBy`, `GroupBy`, `Select`) absent from paths called more than 10,000 times per second — replaced with manual loops?
- Has allocation pressure been profiled in a load test — not estimated by code review alone?
