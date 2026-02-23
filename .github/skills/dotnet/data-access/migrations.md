# EF Core Migrations
> Verified against: .NET 9 | C# 13 | EF Core 9.x
> Last reviewed: 2026-02-22

## The Law
Every migration must be backward-compatible with the previous version of the application running simultaneously — deployments are rolling, not instantaneous.

## Why This Kills You At Scale
You rename a column in a migration and deploy — the new app reads `NewColumnName`, the old app (still running during rolling deploy) reads `OldColumnName`. Old pods get null for every read, write null to the DB, corrupt data for every user hitting an old pod during the 5-minute deploy window. At 100k users, a 5-minute window of corrupt writes produces thousands of corrupted records before the old pods drain.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore.Migrations;

// ✅ Correct: additive migration — new column with default, backward-compatible
public partial class AddUserProfilePictureUrl : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // ✅ Add nullable column — old app ignores it, new app reads/writes it
        // Never add NOT NULL column without default — breaks old app inserts
        migrationBuilder.AddColumn<string>(
            name: "ProfilePictureUrl",
            table: "Users",
            type: "nvarchar(500)",
            nullable: true,
            defaultValue: null);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "ProfilePictureUrl", table: "Users");
    }
}

// ✅ Correct: rename column safely — multi-step over multiple deployments
// Step 1 (Deploy 1): Add new column, write to both columns
public partial class Step1_AddNewUsernameColumn : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "Username",
            table: "Users",
            type: "nvarchar(50)",
            nullable: true); // Nullable — old app doesn't write it

        // Copy existing data
        migrationBuilder.Sql("UPDATE Users SET Username = UserName");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
        => migrationBuilder.DropColumn("Username", "Users");
}

// Step 2 (Deploy 2): Stop writing to old column, read from new column
// Step 3 (Deploy 3): Drop old column
public partial class Step3_DropOldUserNameColumn : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
        => migrationBuilder.DropColumn("UserName", "Users");

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>("UserName", "Users", "nvarchar(50)", nullable: true);
        migrationBuilder.Sql("UPDATE Users SET UserName = Username");
    }
}

// ✅ Correct: apply migrations at startup — not in CI/CD pipeline
// Startup is safer: if migration fails, app doesn't start, no traffic hits broken state
public static async Task ApplyMigrationsAsync(this WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var context = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<AppDbContext>>();

    try
    {
        var pending = await context.Database.GetPendingMigrationsAsync();
        if (pending.Any())
        {
            logger.LogInformation("Applying {Count} pending migrations", pending.Count());
            await context.Database.MigrateAsync();
            logger.LogInformation("Migrations applied successfully");
        }
    }
    catch (Exception ex)
    {
        logger.LogCritical(ex, "Failed to apply migrations — application cannot start");
        throw; // Fail fast — do not start with broken schema
    }
}

// ❌ Wrong: breaking migration — renames column in one step
public partial class BreakingRename : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Old app reads "UserName", new schema only has "Username"
        // Old pods: every read returns null, every write fails
        migrationBuilder.RenameColumn("UserName", "Users", "Username");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
        => migrationBuilder.RenameColumn("Username", "Users", "UserName");
}
```

## The Trap

```csharp
// A senior developer uses the multi-step rename approach correctly.
// All migrations are backward-compatible. Ships.
// The trap: migration lock under high concurrent load.

// When multiple app instances start simultaneously (Kubernetes scaling event,
// rolling restart), all instances call MigrateAsync() at the same time.
// EF Core uses a distributed lock table (__EFMigrationsLock) — but under
// Azure SQL with high concurrent connections, the lock acquisition itself
// can deadlock with application queries that started before the migration lock.

// The symptom: random deadlock exceptions on startup during scaling events.
// Some pods start successfully, others fail with deadlock, Kubernetes restarts them,
// causing a restart loop that takes 10 minutes to stabilize.

// Fix 1: apply migrations in a dedicated startup job (Kubernetes initContainer)
// before any application pods start — eliminates concurrent migration attempts.

// Fix 2: check-then-migrate with leader election
public static async Task ApplyMigrationsWithLeaderElectionAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var context = scope.ServiceProvider.GetRequiredService<AppDbContext>();

    // Only the pod that wins the distributed lock applies migrations
    // Others wait and verify schema is up-to-date before proceeding
    var pending = await context.Database.GetPendingMigrationsAsync();
    if (!pending.Any()) return; // Fast path — most pods take this path

    // Use a separate connection for migration to avoid deadlocks with app connections
    using var migrationContext = new AppDbContext(
        new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer(connectionString, o => o.CommandTimeout(300))
            .Options);

    await migrationContext.Database.MigrateAsync();
}
```

## The Exception
Development and test environments can apply migrations automatically with no backward-compatibility concern — there is no rolling deploy, no simultaneous old+new versions. In production, if you have a maintenance window with zero downtime requirement waived, a single-step breaking migration is acceptable. Document this explicitly in the migration file and coordinate with operations to drain traffic before applying.

## Before You Merge
- Is the new migration backward-compatible — does the previous app version still work against the new schema?
- Are new NOT NULL columns added with a `defaultValue` — so existing rows and old-app inserts succeed?
- Is column/table renaming done in 3 steps across 3 deployments — not in one breaking migration?
- Does `Down()` correctly reverse `Up()` — including data migration steps?
- Does the migration include `WITH (ONLINE = ON)` for index creation on large tables — to avoid table locks?
