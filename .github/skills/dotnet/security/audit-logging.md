# Audit Logging
> Verified against: .NET 9 | C# 13 | Serilog 4.x
> Last reviewed: 2026-02-22

## The Law
Log who did what to which resource and when — as a separate, immutable, append-only audit trail — never by modifying application logs or entity timestamps alone.

## Why This Kills You At Scale
A data breach occurs. Your lawyers ask: "Which users accessed this data? When? From where?" Application logs have been rotated. EF Core UpdatedAt fields show the last modification but not who made it. You cannot answer the question. At 100k users, the inability to produce an audit trail in a breach investigation means regulatory fines, not just embarrassment — GDPR Article 30 requires records of processing activities.

## The Pattern

```csharp
#nullable enable
using Serilog;
using Serilog.Context;

// ✅ Correct: dedicated audit log — separate from application log
// Application log: what the system did (errors, performance, flow)
// Audit log: what users did (business actions, data access, auth events)

public sealed class AuditLogger(ILogger<AuditLogger> logger)
{
    // ✅ Correct: structured audit event — queryable, not just readable
    public void LogDataAccess(
        Guid actorId,
        string actorUsername,
        string action,
        string resourceType,
        Guid resourceId,
        string? ipAddress = null)
    {
        // Use a consistent event type marker for filtering
        using (LogContext.PushProperty("AuditEvent", true))
        using (LogContext.PushProperty("ActorId", actorId))
        using (LogContext.PushProperty("ResourceType", resourceType))
        using (LogContext.PushProperty("ResourceId", resourceId))
        {
            logger.LogInformation(
                "AUDIT | {Action} | Actor: {ActorId} ({ActorUsername}) | " +
                "Resource: {ResourceType}/{ResourceId} | IP: {IpAddress}",
                action, actorId, actorUsername, resourceType, resourceId, ipAddress ?? "unknown");
        }
    }

    public void LogAuthEvent(
        string eventType,
        string identifier,
        bool success,
        string? ipAddress = null,
        string? reason = null)
    {
        using (LogContext.PushProperty("AuditEvent", true))
        using (LogContext.PushProperty("AuthEventType", eventType))
        {
            if (success)
            {
                logger.LogInformation(
                    "AUDIT | {EventType} SUCCESS | Identifier: {Identifier} | IP: {IpAddress}",
                    eventType, identifier, ipAddress ?? "unknown");
            }
            else
            {
                logger.LogWarning(
                    "AUDIT | {EventType} FAILED | Identifier: {Identifier} | IP: {IpAddress} | Reason: {Reason}",
                    eventType, identifier, ipAddress ?? "unknown", reason ?? "unknown");
            }
        }
    }
}

// ✅ Correct: call audit logger at service layer, not controller
public sealed class ConversationService(
    IConversationRepository repo,
    AuditLogger audit,
    ICurrentUserService currentUser)
{
    public async Task<ConversationDto> GetByIdAsync(Guid conversationId, CancellationToken ct)
    {
        var conversation = await repo.GetByIdAsync(conversationId, ct)
            ?? throw new NotFoundException($"Conversation {conversationId} not found");

        // ✅ Audit data access — who read what
        audit.LogDataAccess(
            currentUser.GetUserId(),
            currentUser.GetUsername(),
            "READ_CONVERSATION",
            "Conversation",
            conversationId,
            currentUser.GetIpAddress());

        return conversation.ToDto();
    }
}

// ✅ Correct: Serilog config — write audit to separate sink
// In appsettings.json:
// "Serilog": {
//   "WriteTo": [
//     { "Name": "Console" },
//     {
//       "Name": "File",
//       "Args": { "path": "logs/app-.log", "rollingInterval": "Day" }
//     },
//     {
//       "Name": "File",
//       "Args": {
//         "path": "logs/audit-.log",
//         "rollingInterval": "Day",
//         "filter": { "ByIncludingOnly": "AuditEvent = true" }
//       }
//     }
//   ]
// }

// ❌ Wrong: using UpdatedAt as audit trail
public class InsufficientAudit
{
    // This tells you WHEN something changed — not WHO changed it or from where
    public DateTime UpdatedAt { get; set; }
}
```

## The Trap

```csharp
// A senior developer implements audit logging correctly in services.
// Complete, structured, works perfectly. Ships.
// Compliance audit 6 months later: "Show us all accesses to user X's data."
// The audit log shows the data was accessed, but not which admin triggered it
// because one endpoint was added that bypasses the service layer.

[HttpGet("admin/users/{userId}/messages")]
[Authorize(Roles = "Admin")]
public async Task<IActionResult> GetUserMessages(Guid userId, CancellationToken ct)
{
    // BUG: Goes directly to repository, bypasses service layer where audit logging lives
    var messages = await _messageRepo.GetByUserIdAsync(userId, ct);
    return Ok(messages);
    // Admin accessed 50,000 user messages — no audit trail
}

// Fix: audit logging belongs in a cross-cutting concern, not just the service layer.
// Use an EF Core interceptor to log all queries to sensitive tables:

public sealed class AuditInterceptor(AuditLogger audit, ICurrentUserService currentUser)
    : DbCommandInterceptor
{
    private static readonly HashSet<string> SensitiveTables = ["Messages", "UserSessions", "Users"];

    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        if (SensitiveTables.Any(t => command.CommandText.Contains(t, StringComparison.OrdinalIgnoreCase)))
        {
            audit.LogDataAccess(
                currentUser.GetUserId(),
                currentUser.GetUsername(),
                "DB_QUERY",
                "SensitiveTable",
                Guid.Empty,
                currentUser.GetIpAddress());
        }
        return result;
    }
}
```

## The Exception
High-frequency read operations on non-sensitive data (reading your own profile, listing your own conversations) do not need individual audit log entries — they create noise that buries the signal. Audit the sensitive actions: admin access to other users' data, privilege escalation, authentication events, data deletion, payment operations. For everything else, application logs are sufficient.

## Before You Merge
- Is the audit log written to a separate sink from the application log?
- Does every audit entry include actorId, action, resourceType, resourceId, timestamp, and IP address?
- Are authentication events (login success, login failure, logout, password change) always audited?
- Are admin accesses to other users' data audited — including direct repository calls that bypass service layer?
- Is the audit log append-only — no delete or update operations possible on audit records?
