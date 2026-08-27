/* global db, print, quit, EJSON, _showAll */

var MIN_SAFE_FORMAT_VERSION = 13;
var EXCLUDED_DATABASES = ["admin", "config", "local"];
var PROBLEM_STATUSES = [
    "POTENTIALLY_PRE_42_UNIQUE_INDEX",
    "UNKNOWN_FORMAT_VERSION"
];
var EXIT_CODE_WITH_FINDINGS = 1;
var EXIT_CODE_WITH_ERRORS = 2;
var LEGACY_INDEX_ADVISORY = "This index may have been created before MongoDB 4.2 and as a result may still use a legacy unique-index key format. Use validate as a secondary check, but note that the old-format warning is available starting in MongoDB 6.0. On versions below 6.0, validate may return no warning even when risk remains. Validate is resource consuming, so run it with caution.";
var UNKNOWN_VERSION_ADVISORY = "Unable to determine the index format version from collStats index details. Use validate as a secondary check, but note that the old-format warning is available starting in MongoDB 6.0. On versions below 6.0, validate may return no warning even when risk remains. Validate is resource consuming, so run it with caution.";

if (typeof _showAll === "undefined") {
    var _showAll = false;
}

(function () {
    "use strict";

    function isProblemStatus(status) {
        return PROBLEM_STATUSES.indexOf(status) !== -1;
    }

    function getFormatVersionFromValue(value) {
        if (value && typeof value === "object") {
            value = value.$numberInt || value.$numberLong || value.$numberDouble;
        }

        var version = Number(value);

        return Number.isInteger(version) ? version : null;
    }

    function getFormatVersion(indexDetail) {
        if (!indexDetail) {
            return null;
        }

        var value = indexDetail.formatVersion;

        if (value === undefined && indexDetail.metadata) {
            value = indexDetail.metadata.formatVersion;
        }

        return getFormatVersionFromValue(value);
    }

    function getCollectionNames(database) {
        var collectionNames = [];

        database.getCollectionInfos({ type: "collection" }, { nameOnly: true }).forEach(function (collectionInfo) {
            if (collectionInfo.name.indexOf("system.") === 0) {
                return;
            }

            collectionNames.push(collectionInfo.name);
        });

        return collectionNames;
    }

    function getIndexDetails(database, collectionName) {
        var stats = database.runCommand({
            collStats: collectionName,
            indexDetails: true
        });

        if (!stats.ok) {
            throw new Error(EJSON.stringify(stats));
        }

        return stats;
    }

    function findIndexDetail(indexDetails, indexName) {
        if (!indexDetails) {
            return null;
        }

        if (indexDetails[indexName]) {
            return indexDetails[indexName];
        }

        for (var detailName in indexDetails) {
            if (Object.prototype.hasOwnProperty.call(indexDetails, detailName)) {
                var detail = indexDetails[detailName];

                if (detail && detail.metadata && detail.metadata.name === indexName) {
                    return detail;
                }
            }
        }

        return null;
    }

    function getFormatVersions(stats, indexName) {
        var versions = {};

        var topLevelVersion = getFormatVersion(findIndexDetail(stats.indexDetails, indexName));
        if (topLevelVersion !== null) {
            versions.default = topLevelVersion;
        }

        if (stats.shards) {
            for (var shardName in stats.shards) {
                if (Object.prototype.hasOwnProperty.call(stats.shards, shardName)) {
                    var shardStats = stats.shards[shardName];
                    var shardVersion = getFormatVersion(findIndexDetail(shardStats.indexDetails, indexName));

                    if (shardVersion !== null) {
                        versions[shardName] = shardVersion;
                    }
                }
            }
        }

        return versions;
    }

    function classifyFormatVersions(formatVersions) {
        var versionValues = Object.keys(formatVersions).map(function (location) {
            return formatVersions[location];
        });

        if (versionValues.length === 0) {
            return "UNKNOWN_FORMAT_VERSION";
        }

        var hasLegacyVersion = versionValues.some(function (version) {
            return version < MIN_SAFE_FORMAT_VERSION;
        });

        return hasLegacyVersion ? "POTENTIALLY_PRE_42_UNIQUE_INDEX" : "VALID";
    }

    function getAdvisory(status) {
        if (status === "POTENTIALLY_PRE_42_UNIQUE_INDEX") {
            return LEGACY_INDEX_ADVISORY;
        }

        if (status === "UNKNOWN_FORMAT_VERSION") {
            return UNKNOWN_VERSION_ADVISORY;
        }

        return null;
    }

    function buildSuggestedValidateCommand(databaseName, collectionName) {
        function escapeSingleQuotedLiteral(value) {
            return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        }

        var safeDatabaseName = escapeSingleQuotedLiteral(databaseName);
        var safeCollectionName = escapeSingleQuotedLiteral(collectionName);

        return "db.getSiblingDB('" + safeDatabaseName + "').getCollection('" + safeCollectionName + "').validate({full:true}).warnings";
    }

    function validateIndex(databaseName, collectionName, indexSpec, stats) {
        if (indexSpec.name === "_id_") {
            return null;
        }

        if (indexSpec.unique !== true) {
            return null;
        }

        var formatVersions = getFormatVersions(stats, indexSpec.name);
        var status = classifyFormatVersions(formatVersions);

        var advisory = getAdvisory(status);
        var result = {
            db: databaseName,
            collection: collectionName,
            namespace: databaseName + "." + collectionName,
            indexName: indexSpec.name || "<unnamed>",
            key: indexSpec.key || "<unknown key pattern>",
            formatVersions: Object.keys(formatVersions).length ? formatVersions : "unknown",
            status: status
        };

        if (advisory) {
            result.advisory = advisory;
            result.suggestedValidateCommand = buildSuggestedValidateCommand(databaseName, collectionName);
        }

        return result;
    }

    function getUserDatabases() {
        var response = db.adminCommand("listDatabases");

        if (!response || !response.ok || !Array.isArray(response.databases)) {
            throw new Error("listDatabases failed: " + EJSON.stringify(response));
        }

        return response.databases.filter(function (databaseInfo) {
            return EXCLUDED_DATABASES.indexOf(databaseInfo.name) === -1;
        });
    }

    function collectFindings() {
        var results = [];
        var errors = [];
        var databases = getUserDatabases();

        databases.forEach(function (databaseInfo) {
            var currentDb = db.getSiblingDB(databaseInfo.name);

            getCollectionNames(currentDb).forEach(function (collectionName) {
                var currentCollection = currentDb.getCollection(collectionName);
                var stats;

                try {
                    stats = getIndexDetails(currentDb, collectionName);
                } catch (e) {
                    errors.push({
                        db: databaseInfo.name,
                        collection: collectionName,
                        namespace: databaseInfo.name + "." + collectionName,
                        error: e.message
                    });
                    return;
                }

                currentCollection.getIndexes().forEach(function (indexSpec) {
                    var result = validateIndex(databaseInfo.name, collectionName, indexSpec, stats);

                    if (result) {
                        results.push(result);
                    }
                });
            });
        });

        return {
            results: results,
            errors: errors
        };
    }

    var audit;

    try {
        audit = collectFindings();
    } catch (e) {
        audit = {
            results: [],
            errors: [
                {
                    scope: "cluster",
                    error: e.message
                }
            ]
        };
    }

    var findings = _showAll
        ? audit.results
        : audit.results.filter(function (result) {
            return isProblemStatus(result.status);
        });
    var output = {
        checkedAt: new Date().toISOString(),
        minSafeFormatVersion: MIN_SAFE_FORMAT_VERSION,
        excludedDatabases: EXCLUDED_DATABASES,
        showAll: _showAll,
        totalUniqueIndexesChecked: audit.results.length,
        findings: findings,
        errors: audit.errors
    };
    var hasProblems = audit.results.some(function (result) {
        return isProblemStatus(result.status);
    });

    print(EJSON.stringify(output, null, 2));

    if (audit.errors.length) {
        quit(EXIT_CODE_WITH_ERRORS);
    }

    if (hasProblems) {
        quit(EXIT_CODE_WITH_FINDINGS);
    }
}());
