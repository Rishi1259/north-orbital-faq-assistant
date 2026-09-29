import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evaluationDirectory = path.dirname(
  fileURLToPath(import.meta.url),
);

const apiBase =
  process.env.EVALUATION_API_BASE ??
  'http://localhost:3000';

const cases = JSON.parse(
  await readFile(
    path.join(evaluationDirectory, 'cases.json'),
    'utf8',
  ),
);

const results = [];

async function sourceExists(sourceId) {
  try {
    const response = await fetch(
      `${apiBase}/api/sources/${encodeURIComponent(sourceId)}`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );

    return response.ok;
  } catch {
    return false;
  }
}

for (const testCase of cases) {
  const started = performance.now();

  let status = null;
  let responseBody = null;
  let requestError = null;

  try {
    const response = await fetch(
      `${apiBase}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: testCase.message,
          history: testCase.history,
        }),
        signal: AbortSignal.timeout(40000),
      },
    );

    status = response.status;

    const bodyText = await response.text();

    try {
      responseBody = JSON.parse(bodyText);
    } catch {
      responseBody = {
        rawBody: bodyText,
      };
    }
  } catch (error) {
    requestError =
      error instanceof Error
        ? error.message
        : String(error);
  }

  const durationMs = Math.round(
    performance.now() - started,
  );

  const returnedSourceIds =
    Array.isArray(responseBody?.sources)
      ? responseBody.sources.map(
          (source) => source.id,
        )
      : [];

  const sourceExistence = {};

  for (const sourceId of returnedSourceIds) {
    sourceExistence[sourceId] =
      await sourceExists(sourceId);
  }

  const expectedSourceIds =
    testCase.expectedSourceIds;

  const unexpectedSourceIds =
    returnedSourceIds.filter(
      (id) => !expectedSourceIds.includes(id),
    );

  const missingExpectedSource =
    !testCase.expectedFallback &&
    expectedSourceIds.length > 0 &&
    !returnedSourceIds.some((id) =>
      expectedSourceIds.includes(id),
    );

  const allSourcesExist =
    Object.values(sourceExistence)
      .every(Boolean);

  const checks = {
    http200: status === 200,
    fallbackMatches:
      responseBody?.fallback ===
      testCase.expectedFallback,
    noUnexpectedSources:
      unexpectedSourceIds.length === 0,
    expectedSourcePresent:
      !missingExpectedSource,
    allReturnedSourcesExist:
      allSourcesExist,
    fallbackHasNoSources:
      !testCase.expectedFallback ||
      returnedSourceIds.length === 0,
  };

  const structuralPass =
    requestError === null &&
    Object.values(checks).every(Boolean);

  const result = {
    id: testCase.id,
    category: testCase.category,
    message: testCase.message,
    history: testCase.history,
    expected: {
      fallback: testCase.expectedFallback,
      sourceIds: expectedSourceIds,
      fact: testCase.expectedFact,
    },
    actual: {
      httpStatus: status,
      durationMs,
      answer:
        responseBody?.answer ?? null,
      fallback:
        responseBody?.fallback ?? null,
      sourceIds: returnedSourceIds,
      error:
        responseBody?.error ??
        requestError,
    },
    sourceExistence,
    checks,
    structuralPass,
  };

  results.push(result);

  console.log(
    `${testCase.id} | ${structuralPass ? 'PASS' : 'CHECK'} | ${durationMs} ms`,
  );
}

const completedAt =
  new Date().toISOString();

const successfulDurations =
  results
    .filter(
      (result) =>
        typeof result.actual.durationMs ===
        'number',
    )
    .map(
      (result) => result.actual.durationMs,
    )
    .sort((a, b) => a - b);

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }

  const index = Math.min(
    values.length - 1,
    Math.floor(values.length * fraction),
  );

  return values[index];
}

const structuralPassCount =
  results.filter(
    (result) => result.structuralPass,
  ).length;

const summary = {
  completedAt,
  apiBase,
  totalCases: results.length,
  structuralPassCount,
  structuralCheckCount:
    results.length - structuralPassCount,
  timing: {
    note:
      'Observed timings from this local evaluation run only; not a benchmark.',
    minimumMs:
      successfulDurations[0] ?? null,
    medianMs:
      percentile(
        successfulDurations,
        0.5,
      ),
    p95Ms:
      percentile(
        successfulDurations,
        0.95,
      ),
    maximumMs:
      successfulDurations.at(-1) ??
      null,
  },
};

const output = {
  summary,
  results,
};

const resultsDirectory = path.join(
  evaluationDirectory,
  'results',
);

await mkdir(resultsDirectory, {
  recursive: true,
});

await writeFile(
  path.join(
    resultsDirectory,
    'latest.json',
  ),
  JSON.stringify(output, null, 2) + '\n',
);

function escapeTable(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

const rows = results
  .map((result) => {
    const answer =
      result.actual.answer ??
      JSON.stringify(
        result.actual.error ?? '',
      );

    return [
      result.id,
      result.category,
      result.structuralPass
        ? 'PASS'
        : 'CHECK',
      `${result.actual.durationMs} ms`,
      result.actual.sourceIds.join(', ') ||
        '—',
      escapeTable(answer),
    ].join(' | ');
  })
  .map((row) => `| ${row} |`)
  .join('\n');

const report = `# North Orbital FAQ Assistant — Evaluation Run

Generated: ${completedAt}

## Important interpretation

This report contains actual responses from the configured model during this run.

"Structural PASS" means the HTTP response, fallback behavior, and source-reference rules matched the expected structure. It is **not** an accuracy score.

Answers still require semantic review against the documented expected fact and cited source before claiming correctness.

## Run summary

- Cases: ${summary.totalCases}
- Structural PASS: ${summary.structuralPassCount}
- Needs structural review: ${summary.structuralCheckCount}
- API: ${apiBase}
- Minimum observed request: ${summary.timing.minimumMs} ms
- Median observed request: ${summary.timing.medianMs} ms
- P95 observed request: ${summary.timing.p95Ms} ms
- Maximum observed request: ${summary.timing.maximumMs} ms

These timing figures describe only this local evaluation run and are not a general performance benchmark.

## Results

| ID | Category | Structural | Duration | Sources | Actual answer |
| --- | --- | --- | ---: | --- | --- |
${rows}

## Semantic review

Review each response in \`latest.json\` against:

1. \`expected.fact\`
2. the returned source IDs
3. the corresponding files in \`knowledge/sources.json\`

Record any incorrect, incomplete, misleading, unsupported, or instruction-following behavior as a limitation rather than changing the result.

## Known evaluation limitation

The automated checks can verify source IDs and fallback behavior, but they cannot by themselves prove that natural-language answers are semantically correct. Human review is therefore part of this evaluation.
`;

await writeFile(
  path.join(
    resultsDirectory,
    'latest.md',
  ),
  report,
);

console.log('');
console.log(
  `Structural checks: ${structuralPassCount}/${results.length} passed`,
);
console.log(
  `Results: ${path.join(resultsDirectory, 'latest.md')}`,
);
