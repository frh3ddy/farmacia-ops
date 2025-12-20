#!/bin/bash
# Helper script to create Prisma migrations without requiring a database connection
# Usage: ./scripts/create-migration.sh migration_name

if [ -z "$1" ]; then
  echo "Usage: ./scripts/create-migration.sh migration_name"
  exit 1
fi

MIGRATION_NAME=$1
MIGRATION_DIR="prisma/migrations/$(date +%Y%m%d%H%M%S)_${MIGRATION_NAME}"

# Get the last migration directory
LAST_MIGRATION=$(ls -1 prisma/migrations | grep -E '^[0-9]+_' | sort | tail -1)

if [ -z "$LAST_MIGRATION" ]; then
  echo "Error: No existing migrations found. Use 'prisma migrate dev' with a database connection instead."
  exit 1
fi

echo "Creating migration: ${MIGRATION_NAME}"
echo "Comparing schema against: ${LAST_MIGRATION}"

mkdir -p "$MIGRATION_DIR"

# Generate migration SQL by diffing from last migration to current schema
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --script > "$MIGRATION_DIR/migration.sql"

if [ $? -eq 0 ] && [ -s "$MIGRATION_DIR/migration.sql" ]; then
  echo "✅ Migration created: ${MIGRATION_DIR}"
  echo "📝 Review the migration file before committing:"
  echo "   ${MIGRATION_DIR}/migration.sql"
else
  echo "❌ Failed to create migration or migration is empty"
  rm -rf "$MIGRATION_DIR"
  exit 1
fi

