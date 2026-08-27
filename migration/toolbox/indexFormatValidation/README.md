# Index Format Validation

Checks unique non-`_id_` indexes across all non-system databases for legacy storage engine index format versions that may cause migration issues.

The checker assumes unique indexes with a WiredTiger index `formatVersion` below `13` were created on MongoDB versions earlier than 4.2, or otherwise still use a legacy on-disk format. Indexes with `formatVersion` `13` or newer are reported as valid.

## Usage

```bash
mongosh "<connection-string>" indexFormatValidation.js
```

By default, the script checks all collections in all databases except `admin`, `config`, and `local`. It prints only indexes that need review.

To include valid unique indexes in the output, set `_showAll=true`:

```bash
mongosh "<connection-string>" --eval 'var _showAll=true' indexFormatValidation.js
```

Exit codes:

- `0`: no suspicious indexes found and no runtime errors
- `1`: one or more suspicious indexes found
- `2`: runtime or permission errors were encountered while scanning

## Source Data

The script reads directly from the connected deployment using:

- `listDatabases` to find databases
- `getCollectionInfos({ type: "collection" }, { nameOnly: true })` to find collections
- `getIndexes()` to find unique index specs
- `collStats` with `indexDetails: true` to read WiredTiger index metadata

System databases `admin`, `config`, and `local` are skipped. Collections whose names start with `system.` are also skipped.

The script checks `formatVersion` or `metadata.formatVersion` from the `collStats` index details. Plain `db.collection.getIndexes()` output is not sufficient by itself because its `v` field is the index spec version, not the WiredTiger `formatVersion` checked by this script.

## Output

Each finding includes:

- `namespace`
- `indexName`
- `key`
- `formatVersions`
- `status`
- `suggestedValidateCommand` (only for suspicious findings)
- `advisory` (only for suspicious findings)

For sharded collections, `formatVersions` may contain one entry per shard.

Statuses:

- `POTENTIALLY_PRE_42_UNIQUE_INDEX`: unique index has `formatVersion` lower than `13`
- `UNKNOWN_FORMAT_VERSION`: unique index is missing a parseable `formatVersion`
- `VALID`: unique index has `formatVersion` `13` or newer, shown only when `_showAll=true`

When a suspicious index is found, the `advisory` field is included with guidance to run `validate` as a secondary check. The old unique-index-format warning from `validate` is available starting in MongoDB 6.0; on older versions, `validate` may return no warning even when risk remains. `validate` is resource consuming and should be used with caution.

The `suggestedValidateCommand` field includes a ready-to-run sample in this format:

`db.getSiblingDB('database_name').getCollection('collection_name').validate({full:true}).warnings`