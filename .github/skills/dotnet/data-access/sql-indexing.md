# SQL Indexing Strategy
> Verified against: .NET 9 | C# 13 | EF Core 9.x | SQL Server 2022
> Last reviewed: 2026-02-22

## The Law
Index every foreign key column and every column that appears in a `WHERE` or `ORDER BY` clause on a high-frequency query — an unindexed foreign key on a table with 10 million rows causes full table scans on every join.

## Why This Kills You At Scale
`Messages` table with 50 million rows, no index on `ConversationId` — every message list query does a full table scan. At 100k users each requesting their message history, your SQL Server CPU hits 100%, queries time out, and the app returns 503 for everyone simultaneously. This is not theoretical — it is the most common production incident for chat applications moving from beta to real load.

## The Pattern

```csharp
#nullable enable
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

// ✅ Correct: entity configuration with deliberate index strategy
public sealed class MessageConfiguration : IEntityTypeConfiguration<Message>
{
    public void Configure(EntityTypeBuilder<Message> builder)
    {
        builder.ToTable("Messages");
        builder.HasKey(m => m.Id);

        // ✅ Foreign key index — always index FK columns
        // Query: WHERE ConversationId = @id ORDER BY SentAt DESC
        // Composite: ConversationId first (equality), SentAt second (range/order)
        builder.HasIndex(m => new { m.ConversationId, m.SentAt })
            .HasDatabaseName("IX_Messages_ConversationId_SentAt");

        // ✅ Covering index — INCLUDE columns the query needs, avoids key lookup
        // Without INCLUDE: index finds rows, then fetches each row from clustered index (slow)
        // With INCLUDE: index contains everything the query needs (fast)
        // EF Core fluent API does not support INCLUDE — use migration raw SQL
        // See migration below for the correct SQL

        // ✅ Filtered index — only index non-deleted rows (sparse condition)
        builder.HasIndex(m => m.ConversationId)
            .HasFilter("[IsDeleted] = 0")
            .HasDatabaseName("IX_Messages_ConversationId_Active");

        // ✅ Sender index — for "messages sent by user" queries
        builder.HasIndex(m => new { m.SenderId, m.SentAt })
            .HasDatabaseName("IX_Messages_SenderId_SentAt");
    }
}

public sealed class ConversationParticipantConfiguration
    : IEntityTypeConfiguration<ConversationParticipant>
{
    public void Configure(EntityTypeBuilder<ConversationParticipant> builder)
    {
        builder.ToTable("ConversationParticipants");

        // ✅ Composite PK doubles as index — no separate index needed
        builder.HasKey(p => new { p.ConversationId, p.UserId });

        // ✅ Reverse index — for "conversations for user" queries
        // PK covers (ConversationId, UserId) — cannot use for WHERE UserId = @id
        // This index covers (UserId, ConversationId) — for user's conversation list
        builder.HasIndex(p => new { p.UserId, p.ConversationId })
            .HasDatabaseName("IX_ConversationParticipants_UserId");
    }
}

// ✅ Correct: covering index via raw SQL in migration
// EF Core's HasIndex does not support INCLUDE columns — use raw SQL
public partial class AddMessageCoveringIndex : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // DROP the simple index EF created, replace with covering index
        migrationBuilder.DropIndex("IX_Messages_ConversationId_SentAt", "Messages");

        migrationBuilder.Sql("""
            CREATE NONCLUSTERED INDEX IX_Messages_ConversationId_SentAt_Covering
            ON Messages (ConversationId, SentAt DESC)
            INCLUDE (Id, SenderId, Content, IsDeleted, ReadAt)
            WHERE IsDeleted = 0
            WITH (ONLINE = ON); -- No downtime on SQL Server Enterprise
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("DROP INDEX IX_Messages_ConversationId_SentAt_Covering ON Messages");
        migrationBuilder.CreateIndex("IX_Messages_ConversationId_SentAt", "Messages",
            ["ConversationId", "SentAt"]);
    }
}
```

## The Trap

```csharp
// A senior developer adds all the right indexes at launch.
// Performance is excellent. Ships.
// 6 months later — new feature: search messages by content.

// Developer adds:
builder.HasIndex(m => m.Content)
    .HasDatabaseName("IX_Messages_Content");

// BUG: nonclustered index on a nvarchar(max) or long nvarchar column.
// SQL Server cannot index nvarchar columns longer than 900 bytes.
// Migration runs in development (small content values, short strings).
// Migration fails in production with:
// "Column 'Content' in table 'Messages' exceeds the maximum key length of 900 bytes."
//
// Even if it succeeds: a B-tree index on message content is useless for LIKE '%search%'
// (leading wildcard prevents index seek) and catastrophic for storage
// — content index is larger than the data itself for chat messages.
//
// Fix: use SQL Server Full-Text Search for message content search.
// Not a B-tree index. Full-text index. Completely different mechanism.

migrationBuilder.Sql("""
    CREATE FULLTEXT CATALOG MessagesCatalog AS DEFAULT;
    CREATE FULLTEXT INDEX ON Messages(Content)
        KEY INDEX PK_Messages
        ON MessagesCatalog
        WITH CHANGE_TRACKING AUTO;
    """);

// Query uses CONTAINS or FREETEXT — not LIKE
// WHERE CONTAINS(Content, @searchTerm)
```

## The Exception
Tables with fewer than 10,000 rows that are read infrequently (admin lookup tables, configuration tables, role definitions) do not need explicit indexes beyond the primary key — the query optimizer will prefer a table scan for small tables because the overhead of an index seek plus key lookup exceeds the cost of reading a few data pages. Index only tables that will grow, are read frequently, or are joined frequently.

## Before You Merge
- Does every foreign key column have a corresponding index — especially `ConversationId`, `UserId`, `SenderId`?
- Are composite indexes ordered with equality columns first, range/order columns last?
- Do covering indexes use raw SQL in migrations to add `INCLUDE` columns — not just EF Core's `HasIndex`?
- Are filtered indexes used for soft-delete patterns — `WHERE IsDeleted = 0`?
- Has the execution plan been checked in SSMS for any new query hitting more than 10,000 rows?
