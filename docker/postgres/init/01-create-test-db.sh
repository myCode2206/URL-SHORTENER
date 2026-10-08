#!/bin/sh
# Runs once, when the data volume is first created. Integration tests use a
# separate database so they can wipe tables without touching your dev data.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE \"${POSTGRES_DB}_test\";"
