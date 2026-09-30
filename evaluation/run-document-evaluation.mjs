import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evaluationDirectory =
  path.dirname(
    fileURLToPath(import.meta.url),
  );

const apiBase =
  process.env.EVALUATION_API_BASE ??
  'http://localhost:3000';

const cases = JSON.parse(
  await readFile(
    path.join(
      evaluationDirectory,
      'document-cases.json',
    ),
    'utf8',
  ),
);

function matchesExpectedSource(
  expected,
  actual,
) {
  if (
    expected.id &&
    expected.id !== actual.id
  ) {
    return false;
  }

  if (
    expected.kind &&
    expected.kind !== actual.kind
  ) {
    return false;
  }

  if (
    expected.title &&
    expected.title !== actual.title
  ) {
    return false;
  }

  if (
    expected.location &&
    expected.location !== actual.location
  ) {
    return false;
  }

  return true;
}

async function sourceExists(source) {
  if (!source?.path) {
    return false;
  }

  try {
    const response =
      await fetch(
        `${apiBase}/api${source.path}`,
        {
          signal:
            AbortSignal.timeout(
              5000,
            ),
        },
      );

    return response.ok;
  } catch {
    return false;
  }
}

const results = [];

for (const testCase of cases) {
  const started =
    performance.now();

  let status = null;
  let responseBody = null;
  let requestError = null;

  try {
    const response =
      await fetch(
        `${apiBase}/api/chat`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',
          },

          body: JSON.stringify({
            message:
              testCase.message,

            history:
              testCase.history,
          }),

          signal:
            AbortSignal.timeout(
              40000,
            ),
        },
      );

    status = response.status;

    const text =
      await response.text();

    try {
      responseBody =
        JSON.parse(text);
    } catch {
      responseBody = {
        rawBody: text,
      };
    }
  } catch (error) {
    requestError =
      error instanceof Error
        ? error.message
        : String(error);
  }

  const durationMs =
    Math.round(
      performance.now() -
        started,
    );

  const actualSources =
    Array.isArray(
      responseBody?.sources,
    )
      ? responseBody.sources
      : [];

  const sourceChecks = [];

  for (
    const source of actualSources
  ) {
    sourceChecks.push({
      id: source.id,
      exists:
        await sourceExists(
          source,
        ),
    });
  }

  const expectedSourcesPresent =
    testCase.expectedSources.every(
      (expected) =>
        actualSources.some(
          (actual) =>
            matchesExpectedSource(
              expected,
              actual,
            ),
        ),
    );

  const checks = {
    http200:
      status === 200,

    fallbackMatches:
      responseBody?.fallback ===
      testCase.expectedFallback,

    expectedSourcesPresent,

    fallbackHasNoSources:
      !testCase.expectedFallback ||
      actualSources.length === 0,

    allReturnedSourcesExist:
      sourceChecks.every(
        (item) =>
          item.exists,
      ),
  };

  const structuralPass =
    requestError === null &&
    Object.values(
      checks,
    ).every(Boolean);

  results.push({
    id: testCase.id,
    category:
      testCase.category,

    message:
      testCase.message,

    expected: {
      fallback:
        testCase.expectedFallback,

      sources:
        testCase.expectedSources,

      fact:
        testCase.expectedFact,
    },

    actual: {
      httpStatus:
        status,

      durationMs,

      answer:
        responseBody?.answer ??
        null,

      fallback:
        responseBody?.fallback ??
        null,

      sources:
        actualSources,

      error:
        responseBody?.error ??
        requestError,
    },

    sourceChecks,
    checks,
    structuralPass,
  });

  console.log(
    `${testCase.id} | ${
      structuralPass
        ? 'PASS'
        : 'CHECK'
    } | ${durationMs} ms`,
  );
}

const completedAt =
  new Date().toISOString();

const passCount =
  results.filter(
    (result) =>
      result.structuralPass,
  ).length;

const timings =
  results
    .filter(
      (result) =>
        result.actual.httpStatus ===
        200,
    )
    .map(
      (result) =>
        result.actual.durationMs,
    )
    .sort(
      (a, b) => a - b,
    );

function percentile(
  values,
  fraction,
) {
  if (values.length === 0) {
    return null;
  }

  const index =
    Math.min(
      values.length - 1,
      Math.floor(
        values.length *
          fraction,
      ),
    );

  return values[index];
}

const summary = {
  completedAt,
  apiBase,
  totalCases:
    results.length,
  structuralPassCount:
    passCount,

  timing: {
    note:
      'Observed local run timings only; not a benchmark.',

    minimumMs:
      timings[0] ??
      null,

    medianMs:
      percentile(
        timings,
        0.5,
      ),

    p95Ms:
      percentile(
        timings,
        0.95,
      ),

    maximumMs:
      timings.at(-1) ??
      null,
  },
};

const resultsDirectory =
  path.join(
    evaluationDirectory,
    'document-results',
  );

await mkdir(
  resultsDirectory,
  {
    recursive: true,
  },
);

await writeFile(
  path.join(
    resultsDirectory,
    'latest.json',
  ),

  JSON.stringify(
    {
      summary,
      results,
    },
    null,
    2,
  ) + '\n',
);

const rows =
  results
    .map((result) => {
      const sources =
        result.actual.sources
          .map((source) => {
            const location =
              source.location
                ? ` (${source.location})`
                : '';

            return `${source.title}${location}`;
          })
          .join('; ') ||
        '—';

      const answer =
        String(
          result.actual.answer ??
          JSON.stringify(
            result.actual.error ??
              '',
          ),
        )
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ');

      return `| ${result.id} | ${result.category} | ${
        result.structuralPass
          ? 'PASS'
          : 'CHECK'
      } | ${result.actual.durationMs} ms | ${sources} | ${answer} |`;
    })
    .join('\n');

const report = `# Document Search Evaluation

Generated: ${completedAt}

## Interpretation

These are actual responses from the configured local model.

A structural PASS verifies response status, fallback behavior, expected citation location, and source availability.

It does not by itself prove semantic correctness. Each answer should also be reviewed against the expected fact and source excerpt.

## Summary

- Cases: ${results.length}
- Structural PASS: ${passCount}
- Needs review: ${results.length - passCount}
- Minimum observed request: ${summary.timing.minimumMs} ms
- Median observed request: ${summary.timing.medianMs} ms
- P95 observed request: ${summary.timing.p95Ms} ms
- Maximum observed request: ${summary.timing.maximumMs} ms

Timing values describe this local run only.

## Results

| ID | Category | Structural | Duration | Sources | Actual answer |
| --- | --- | --- | ---: | --- | --- |
${rows}

## Human semantic review

For every result, compare:

1. \`expected.fact\`
2. \`actual.answer\`
3. \`actual.sources\`
4. the returned document excerpt or FAQ source

Record incorrect, incomplete, unsupported, or misleading behavior as a limitation.
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
  `Structural checks: ${passCount}/${results.length} passed`,
);

console.log(
  `Results: ${path.join(resultsDirectory, 'latest.md')}`,
);
