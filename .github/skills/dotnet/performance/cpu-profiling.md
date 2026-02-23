# CPU & Allocation Profiling
> Verified against: .NET 9 | C# 13 | BenchmarkDotNet 0.14.x | dotnet-trace | dotnet-counters
> Last reviewed: 2026-02-22

## The Law
Measure before you optimise — profile under production-realistic load, identify the actual bottleneck, optimise that specific bottleneck, then measure again to confirm the gain; never optimise based on assumptions or code review intuition alone.

## Why This Kills You At Scale
At one billion users, a developer "optimises" the wrong thing based on intuition — rewrites the LINQ in the message formatter (saves 0.01ms) while the actual bottleneck is a serialization reflection call in the response pipeline (costs 45ms). Three days of engineering effort, zero throughput improvement, maintenance burden increased. At scale, the wrong optimisation is not neutral — it adds complexity, reduces readability, and makes the codebase harder to change when the real bottleneck is finally identified. Profile. Always profile.

## The Pattern

```csharp
#nullable enable
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

// ✅ Correct: BenchmarkDotNet for micro-benchmarks — eliminates JIT warm-up, GC noise
[MemoryDiagnoser]          // Shows allocations per operation
[ThreadingDiagnoser]       // Shows contention and lock waits
[EventPipeProfiler(EventPipeProfile.CpuSampling)] // CPU profiling integrated
[SimpleJob(RuntimeMoniker.Net90)]
public class MessageSerializationBenchmarks
{
    private MessageDto _message = null!;
    private static readonly JsonSerializerOptions _reflectionOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    [GlobalSetup]
    public void Setup()
    {
        _message = new MessageDto(
            Guid.NewGuid(),
            "Hello, world! This is a benchmark message.",
            Guid.NewGuid(),
            "testuser",
            DateTime.UtcNow,
            null,
            DeliveryStatus.Saved);
    }

    [Benchmark(Baseline = true)]
    public string ReflectionBasedSerialization()
        => JsonSerializer.Serialize(_message, _reflectionOptions);

    [Benchmark]
    public string SourceGeneratedSerialization()
        => JsonSerializer.Serialize(_message, AppJsonContext.Default.MessageDto);

    [Benchmark]
    public byte[] Utf8BytesSerialization()
        => JsonSerializer.SerializeToUtf8Bytes(_message, AppJsonContext.Default.MessageDto);

    // Expected output (reference):
    // | Method                        | Mean    | Gen0   | Allocated |
    // | ReflectionBasedSerialization  | 2.41 µs | 0.0381 | 320 B     |
    // | SourceGeneratedSerialization  | 0.89 µs | 0.0153 | 128 B     |
    // | Utf8BytesSerialization        | 0.71 µs | 0.0095 | 80 B      |
}

// ✅ Correct: dotnet-counters for live production monitoring
// In terminal on prod pod:
// dotnet-counters monitor --process-id <pid> --counters \
//   System.Runtime[cpu-usage,gc-heap-size,threadpool-thread-count, \
//                  threadpool-queue-length,monitor-lock-contention-count, \
//                  active-timer-count] \
//   Microsoft.AspNetCore.Hosting[requests-per-second,current-requests, \
//                                 failed-requests,request-duration]

// ✅ Correct: dotnet-trace for CPU flamegraph
// dotnet-trace collect --process-id <pid> \
//   --profile cpu-sampling \
//   --duration 00:00:30 \
//   --output trace.nettrace
// Then open in PerfView or SpeedScope (https://speedscope.app)

// ✅ Correct: EventCounters for custom application metrics — zero allocation
public sealed class PerformanceCounters
{
    private static readonly PerformanceCounters Instance = new();

    private readonly EventCounter _messageSerializationDuration;
    private readonly PollingCounter _activeConnections;
    private long _activeConnectionCount;

    private PerformanceCounters()
    {
        var source = new EventSource("PutZige.Performance");

        _messageSerializationDuration = new EventCounter(
            "message-serialization-duration-ms",
            source)
        {
            DisplayName = "Message Serialization Duration (ms)"
        };

        _activeConnections = new PollingCounter(
            "active-signalr-connections",
            source,
            () => Interlocked.Read(ref _activeConnectionCount))
        {
            DisplayName = "Active SignalR Connections"
        };
    }

    public static void RecordSerializationDuration(double milliseconds)
        => Instance._messageSerializationDuration.WriteMetric(milliseconds);

    public static void IncrementConnections()
        => Interlocked.Increment(ref Instance._activeConnectionCount);

    public static void DecrementConnections()
        => Interlocked.Decrement(ref Instance._activeConnectionCount);
}

// ✅ Correct: measure hot path with Stopwatch.GetTimestamp() — zero allocation
public sealed class MessageSerializer
{
    public byte[] Serialize(MessageDto dto)
    {
        var start = Stopwatch.GetTimestamp();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(dto,
            AppJsonContext.Default.MessageDto);
        var elapsed = Stopwatch.GetElapsedTime(start).TotalMilliseconds;

        // ✅ Record to EventCounter — picked up by dotnet-counters
        PerformanceCounters.RecordSerializationDuration(elapsed);

        return bytes;
    }
}

// ✅ Correct: allocation-free hotpath measurement with DiagnosticSource
public sealed class HotPathMeasurement
{
    // DiagnosticSource has IsEnabled() fast path — zero cost when no listener attached
    private static readonly DiagnosticSource _diagnostics
        = new DiagnosticListener("PutZige.HotPath");

    public static void MeasureIf<T>(string name, T payload)
    {
        // IsEnabled() check is branch-predicted away when no listener
        if (_diagnostics.IsEnabled(name))
            _diagnostics.Write(name, payload);
    }
}

// ✅ Correct: allocation profiling gate in CI — prevent allocation regressions
[Fact]
public void SendMessage_HotPath_AllocatesLessThan_500Bytes()
{
    var before = GC.GetAllocatedBytesForCurrentThread();

    // Run the hot path — serialization, response construction
    var dto = new MessageDto(Guid.NewGuid(), "Test", Guid.NewGuid(),
        "user", DateTime.UtcNow, null, DeliveryStatus.Saved);
    var bytes = JsonSerializer.SerializeToUtf8Bytes(dto,
        AppJsonContext.Default.MessageDto);

    var after = GC.GetAllocatedBytesForCurrentThread();
    var allocated = after - before;

    // ✅ Fails CI if someone changes serialization to reflect-based — catches regressions
    Assert.True(allocated < 500,
        $"Hot path allocated {allocated} bytes — exceeds 500 byte budget");
}
```

## The Trap

```csharp
// A senior developer uses BenchmarkDotNet, dotnet-trace, EventCounters.
// Bottlenecks identified from data, not intuition. Ships.
// The trap: benchmarks run in Release mode but production is running Debug mode.

// Debug mode disables JIT optimisations, does not inline methods,
// keeps all local variables alive (preventing stack reuse),
// and runs additional bounds checks on array access.
// A method that takes 0.5µs in Release takes 4µs in Debug.
// An "optimisation" that shows 3x improvement in the benchmark
// shows 0.5x improvement in production — actually makes things worse
// because the "optimised" code has higher complexity that the Debug JIT can't handle.

// This is not theoretical. Production environments misconfigured to run Debug
// (Dockerfile uses dotnet build without --configuration Release) show this constantly.

// Verify in Dockerfile:
// ✅ Correct:
// RUN dotnet publish -c Release -o /app/publish

// ✅ Verify at runtime:
public sealed class StartupValidator(ILogger<StartupValidator> logger)
    : IHostedService
{
    public Task StartAsync(CancellationToken ct)
    {
        #if DEBUG
        logger.LogWarning(
            "⚠ APPLICATION RUNNING IN DEBUG MODE — performance will be severely degraded. " +
            "Ensure Dockerfile uses 'dotnet publish -c Release'");
        #endif

        var compiledInRelease = !System.Diagnostics.Debugger.IsAttached
            && typeof(StartupValidator).Assembly.GetCustomAttribute<
                System.Diagnostics.DebuggableAttribute>() is { } attr
            && (attr.DebuggingFlags & DebuggableAttribute.DebuggingModes.DisableOptimizations) == 0;

        if (!compiledInRelease)
            logger.LogWarning("Assembly compiled with optimisations disabled");

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

## The Exception
The measurement-first rule has one legitimate bypass: well-understood, proven optimisations with documented performance profiles — `ArrayPool<T>` over `new byte[]`, `Span<T>` over `string.Substring()`, `StringBuilder` over string concatenation in loops. These have been profiled at Microsoft scale across thousands of .NET applications and the results are consistent. Apply them on hot paths without benchmarking each specific case. Everything else — custom algorithms, caching strategies, parallelism patterns — measure first.

## Before You Merge
- Is every performance-sensitive change validated with a BenchmarkDotNet benchmark run in `Release` mode — not Debug?
- Does CI include an allocation budget test for hot-path operations using `GC.GetAllocatedBytesForCurrentThread()`?
- Is the Docker publish command using `-c Release` — not the default Debug configuration?
- Are custom `EventCounter` metrics emitted for the top 5 hot paths — visible in `dotnet-counters` without code changes?
- Has `dotnet-trace` been run against a staging environment under load before any performance claim is accepted as fact?
