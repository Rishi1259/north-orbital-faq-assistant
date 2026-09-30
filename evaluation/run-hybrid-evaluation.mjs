import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';

import {
  dirname,
  resolve,
} from 'node:path';

import {
  fileURLToPath,
} from 'node:url';

const here =
  dirname(
    fileURLToPath(
      import.meta.url,
    ),
  );

const cases =
  JSON.parse(
    await readFile(
      resolve(
        here,
        'hybrid-cases.json',
      ),
      'utf8',
    ),
  );

const baseUrl =
  process.env.CHAT_BASE_URL ??
  'http://localhost:3000';

const results = [];

function normalize(value) {
  return String(
    value ?? '',
  )
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

for (const testCase of cases) {
  const started =
    performance.now();

  let result;

  try {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        45000,
      );

    let response;

    try {
      response =
        await fetch(
          `${baseUrl}/api/chat`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body:
              JSON.stringify({
                message:
                  testCase.question,
                history: [],
              }),

            signal:
              controller.signal,
          },
        );
    } finally {
      clearTimeout(timeout);
    }

    const payload =
      await response.json();

    const answer =
      normalize(
        payload.answer ??
        payload.message ??
        '',
      );

    const sourceIds =
      Array.isArray(
        payload.sources,
      )
        ? payload.sources
            .map(
              (source) =>
                source?.id,
            )
            .filter(Boolean)
        : [];

    const failures = [];

    if (!response.ok) {
      failures.push(
        `HTTP ${response.status}`,
      );
    }

    if (
      Boolean(
        payload.fallback,
      ) !==
      testCase.expectedFallback
    ) {
      failures.push(
        `expected fallback=${testCase.expectedFallback}, received fallback=${Boolean(payload.fallback)}`,
      );
    }

    for (
      const expectedSourceId of
        testCase.expectedSourceIds
    ) {
      if (
        !sourceIds.includes(
          expectedSourceId,
        )
      ) {
        failures.push(
          `missing source ${expectedSourceId}`,
        );
      }
    }

    if (
      testCase.expectedFallback &&
      sourceIds.length > 0
    ) {
      failures.push(
        `fallback response unexpectedly returned sources: ${sourceIds.join(', ')}`,
      );
    }

    if (
      Array.isArray(
        testCase.answerContainsAny,
      ) &&
      testCase.answerContainsAny.length >
        0
    ) {
      const matched =
        testCase.answerContainsAny.some(
          (candidate) =>
            answer.includes(
              normalize(candidate),
            ),
        );

      if (!matched) {
        failures.push(
          `answer did not contain any of: ${testCase.answerContainsAny.join(', ')}`,
        );
      }
    }

    result = {
      id:
        testCase.id,

      question:
        testCase.question,

      passed:
        failures.length === 0,

      failures,

      fallback:
        Boolean(
          payload.fallback,
        ),

      sourceIds,

      answer:
        payload.answer ??
        payload.message ??
        '',

      durationMs:
        Math.round(
          performance.now() -
          started,
        ),
    };
  } catch (error) {
    result = {
      id:
        testCase.id,

      question:
        testCase.question,

      passed: false,

      failures: [
        error instanceof Error
          ? error.message
          : String(error),
      ],

      fallback: null,
      sourceIds: [],
      answer: '',

      durationMs:
        Math.round(
          performance.now() -
          started,
        ),
    };
  }

  results.push(result);

  console.log(
    `${result.passed ? 'PASS' : 'FAIL'} ${result.id} (${result.durationMs}ms)`,
  );

  if (!result.passed) {
    for (
      const failure of
        result.failures
    ) {
      console.log(
        `  - ${failure}`,
      );
    }
  }
}

const passed =
  results.filter(
    (result) =>
      result.passed,
  ).length;

const summary = {
  generatedAt:
    new Date().toISOString(),

  total:
    results.length,

  passed,

  failed:
    results.length -
    passed,

  results,
};

const resultsDirectory =
  resolve(
    here,
    'hybrid-results',
  );

await mkdir(
  resultsDirectory,
  {
    recursive: true,
  },
);

await writeFile(
  resolve(
    resultsDirectory,
    'latest.json',
  ),
  JSON.stringify(
    summary,
    null,
    2,
  ) + '\n',
);

const markdown = [
  '# Hybrid RAG Evaluation',
  '',
  `Generated: ${summary.generatedAt}`,
  '',
  `Structural checks: ${passed}/${results.length} passed.`,
  '',
  '| Case | Result | Time |',
  '| --- | --- | ---: |',
  ...results.map(
    (result) =>
      `| ${result.id} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.durationMs} ms |`,
  ),
  '',
];

await writeFile(
  resolve(
    resultsDirectory,
    'latest.md',
  ),
  markdown.join('\n'),
);

console.log('');
console.log(
  `Structural checks: ${passed}/${results.length} passed.`,
);

console.log(
  `Results: ${resolve(resultsDirectory, 'latest.json')}`,
);

if (
  passed !==
  results.length
) {
  process.exitCode = 1;
}
