import { useCallback, useEffect, useMemo, useState } from "react";

const QUESTION_COUNT = 50;
const DURATION_SECONDS = 50 * 60;
const PASS_MARK = 45;
const STORAGE_HISTORY = "ftt.history.v1";
const STORAGE_ACTIVE_PREFIX = "ftt.active.v1.";
const STORAGE_PRACTICE = "ftt.practice.v1";

type OptionKey = "A" | "B" | "C";
type ReviewFilter = "all" | "incorrect" | "unanswered" | "flagged";
type PracticeMode = "all" | "mistakes";

type TestIndexItem = {
  setNo: number;
  title: string;
  questionCount: number;
  file: string;
};

type Question = {
  id: string;
  setNo: number;
  questionNo: number;
  question: string;
  media: string | null;
  options: Array<{ key: OptionKey; text: string }>;
  answer: OptionKey;
};

type TestSet = {
  setNo: number;
  title: string;
  questionCount: number;
  questions: Question[];
};

type AttemptBase = {
  id: string;
  testSet: number;
  testTitle: string;
  startedAt: number;
  durationSeconds: number;
  order: number[];
  answers: Record<string, OptionKey>;
  flags: Record<string, boolean>;
  shuffled: boolean;
};

type ActiveAttempt = AttemptBase & {
  currentQuestionNo: number;
};

type CompletedAttempt = AttemptBase & {
  completedAt: number;
  submittedBy: "manual" | "timer";
  score: number;
  percentage: number;
  passed: boolean;
  timeTakenSeconds: number;
  questionsAnswered: number;
};

type PracticeQuestionRecord = {
  selected: OptionKey;
  correct: boolean;
  attempts: number;
  firstAnsweredAt: number;
  lastAnsweredAt: number;
  sourceSetNo: number;
  questionNo: number;
};

type PracticeCurrentAnswer = {
  questionId: string;
  selected: OptionKey;
  correct: boolean;
  answeredAt: number;
};

type PracticeProgress = {
  records: Record<string, PracticeQuestionRecord>;
  flags: Record<string, boolean>;
  currentQuestionId: string | null;
  currentAnswer: PracticeCurrentAnswer | null;
  mode: PracticeMode;
  updatedAt: number | null;
};

type ViewState =
  | { name: "home" }
  | { name: "confirm"; setNo: number }
  | { name: "exam"; setNo: number }
  | { name: "result"; attemptId: string }
  | { name: "review"; attemptId: string }
  | { name: "practice" };

function activeKey(setNo: number) {
  return `${STORAGE_ACTIVE_PREFIX}${setNo}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function formatDate(timestamp?: number) {
  if (!timestamp) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatDuration(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function shuffleNumbers(values: number[]) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function getRemainingSeconds(attempt: AttemptBase) {
  const elapsed = Math.floor((Date.now() - attempt.startedAt) / 1000);
  return Math.max(0, attempt.durationSeconds - elapsed);
}

function mediaUrl(question: Question) {
  return question.media ? `/data/${question.media}` : null;
}

function createEmptyPracticeProgress(): PracticeProgress {
  return {
    records: {},
    flags: {},
    currentQuestionId: null,
    currentAnswer: null,
    mode: "all",
    updatedAt: null,
  };
}

function getPracticeStats(progress: PracticeProgress, totalQuestions: number) {
  const records = Object.values(progress.records);
  const attempted = records.length;
  const correct = records.filter((record) => record.correct).length;
  const needsPracticeIds = new Set([
    ...Object.entries(progress.records)
      .filter(([, record]) => !record.correct)
      .map(([id]) => id),
    ...Object.entries(progress.flags)
      .filter(([, flagged]) => flagged)
      .map(([id]) => id),
  ]);

  return {
    attempted,
    correct,
    accuracy: attempted ? Math.round((correct / attempted) * 100) : 0,
    remaining: Math.max(0, totalQuestions - attempted),
    needsPractice: needsPracticeIds.size,
  };
}

function isNeedsPractice(question: Question, progress: PracticeProgress) {
  const record = progress.records[question.id];
  return Boolean(progress.flags[question.id]) || Boolean(record && !record.correct);
}

function getPracticePool(questions: Question[], progress: PracticeProgress) {
  if (progress.mode === "mistakes") {
    return questions.filter((question) => isNeedsPractice(question, progress));
  }

  const unseen = questions.filter((question) => !progress.records[question.id]);
  if (unseen.length > 0) return unseen;
  return questions.filter((question) => isNeedsPractice(question, progress));
}

function pickQuestion(questions: Question[], avoidQuestionId?: string | null) {
  const choices =
    avoidQuestionId && questions.length > 1
      ? questions.filter((question) => question.id !== avoidQuestionId)
      : questions;
  return choices[Math.floor(Math.random() * choices.length)] ?? null;
}

function App() {
  const [view, setView] = useState<ViewState>({ name: "home" });
  const [testIndex, setTestIndex] = useState<TestIndexItem[]>([]);
  const [tests, setTests] = useState<Record<number, TestSet>>({});
  const [allPracticeQuestions, setAllPracticeQuestions] = useState<Question[] | null>(null);
  const [history, setHistory] = useState<CompletedAttempt[]>(() => readJson(STORAGE_HISTORY, []));
  const [activeAttempts, setActiveAttempts] = useState<Record<number, ActiveAttempt | null>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastResultId, setLastResultId] = useState<string | null>(null);
  const [practiceProgress, setPracticeProgress] = useState<PracticeProgress>(() =>
    readJson(STORAGE_PRACTICE, createEmptyPracticeProgress()),
  );

  useEffect(() => {
    let cancelled = false;

    async function loadIndex() {
      try {
        const response = await fetch("/data/index.json");
        if (!response.ok) throw new Error(`Unable to load question index (${response.status})`);
        const index = (await response.json()) as TestIndexItem[];
        if (cancelled) return;
        setTestIndex(index);
        setActiveAttempts(
          Object.fromEntries(index.map((item) => [item.setNo, readJson<ActiveAttempt | null>(activeKey(item.setNo), null)])),
        );
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Unable to load question data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadIndex();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadTest = useCallback(
    async (setNo: number) => {
      if (tests[setNo]) return tests[setNo];

      const item = testIndex.find((entry) => entry.setNo === setNo);
      if (!item) throw new Error(`Unknown test set ${setNo}`);

      const response = await fetch(`/data/${item.file}`);
      if (!response.ok) throw new Error(`Unable to load ${item.title}`);
      const test = (await response.json()) as TestSet;
      setTests((current) => ({ ...current, [setNo]: test }));
      return test;
    },
    [testIndex, tests],
  );

  const loadAllQuestions = useCallback(async () => {
    if (allPracticeQuestions) return allPracticeQuestions;

    const loadedTests = await Promise.all(
      testIndex.map(async (item) => {
        const cached = tests[item.setNo];
        if (cached) return cached;

        const response = await fetch(`/data/${item.file}`);
        if (!response.ok) throw new Error(`Unable to load ${item.title}`);
        return (await response.json()) as TestSet;
      }),
    );
    const questions = loadedTests.flatMap((test) => test.questions);
    setAllPracticeQuestions(questions);
    setTests((current) => ({
      ...current,
      ...Object.fromEntries(loadedTests.map((test) => [test.setNo, test])),
    }));
    return questions;
  }, [allPracticeQuestions, testIndex, tests]);

  const saveActive = useCallback((attempt: ActiveAttempt | null, setNo: number) => {
    if (attempt) {
      writeJson(activeKey(setNo), attempt);
    } else {
      window.localStorage.removeItem(activeKey(setNo));
    }
    setActiveAttempts((current) => ({ ...current, [setNo]: attempt }));
  }, []);

  const saveHistory = useCallback((items: CompletedAttempt[]) => {
    writeJson(STORAGE_HISTORY, items);
    setHistory(items);
  }, []);

  const savePracticeProgress = useCallback((progress: PracticeProgress) => {
    const next = { ...progress, updatedAt: Date.now() };
    writeJson(STORAGE_PRACTICE, next);
    setPracticeProgress(next);
  }, []);

  const startPractice = useCallback(
    (mode: PracticeMode) => {
      const next =
        practiceProgress.mode === mode
          ? practiceProgress
          : { ...practiceProgress, mode, currentQuestionId: null, currentAnswer: null };
      savePracticeProgress(next);
      setView({ name: "practice" });
    },
    [practiceProgress, savePracticeProgress],
  );

  const submitAttempt = useCallback(
    async (attempt: ActiveAttempt, submittedBy: "manual" | "timer") => {
      const test = await loadTest(attempt.testSet);
      const score = attempt.order.reduce((total, questionNo) => {
        const question = test.questions.find((item) => item.questionNo === questionNo);
        return question && attempt.answers[String(questionNo)] === question.answer ? total + 1 : total;
      }, 0);
      const timeTakenSeconds = Math.min(
        attempt.durationSeconds,
        Math.max(0, Math.floor((Date.now() - attempt.startedAt) / 1000)),
      );
      const completed: CompletedAttempt = {
        ...attempt,
        completedAt: Date.now(),
        submittedBy,
        score,
        percentage: Math.round((score / QUESTION_COUNT) * 100),
        passed: score >= PASS_MARK,
        timeTakenSeconds,
        questionsAnswered: Object.keys(attempt.answers).length,
      };
      const nextHistory = [completed, ...history];
      saveHistory(nextHistory);
      saveActive(null, attempt.testSet);
      setLastResultId(completed.id);
      setView({ name: "result", attemptId: completed.id });
      return completed;
    },
    [history, loadTest, saveActive, saveHistory],
  );

  function getAttemptForResult(attemptId: string) {
    return history.find((attempt) => attempt.id === attemptId) ?? (lastResultId === attemptId ? history[0] : undefined);
  }

  if (loading) {
    return <Shell><div className="center-state loading-state">Loading FTT question sets...</div></Shell>;
  }

  if (loadError) {
    return <Shell><div className="center-state error">{loadError}</div></Shell>;
  }

  return (
    <Shell>
      {view.name === "home" && (
        <HomePage
          testIndex={testIndex}
          history={history}
          activeAttempts={activeAttempts}
          practiceProgress={practiceProgress}
          onStart={(setNo) => setView({ name: "confirm", setNo })}
          onResume={(setNo) => setView({ name: "exam", setNo })}
          onReview={(attemptId) => setView({ name: "review", attemptId })}
          onPractice={startPractice}
        />
      )}
      {view.name === "confirm" && (
        <StartConfirmation
          setNo={view.setNo}
          testIndex={testIndex}
          activeAttempt={activeAttempts[view.setNo] ?? null}
          onBack={() => setView({ name: "home" })}
          onResume={() => setView({ name: "exam", setNo: view.setNo })}
          onStart={async (shuffle) => {
            const test = await loadTest(view.setNo);
            const baseOrder = test.questions.map((question) => question.questionNo);
            const order = shuffle ? shuffleNumbers(baseOrder) : baseOrder;
            const attempt: ActiveAttempt = {
              id: crypto.randomUUID(),
              testSet: test.setNo,
              testTitle: test.title,
              startedAt: Date.now(),
              durationSeconds: DURATION_SECONDS,
              order,
              answers: {},
              flags: {},
              currentQuestionNo: order[0],
              shuffled: shuffle,
            };
            saveActive(attempt, view.setNo);
            setView({ name: "exam", setNo: view.setNo });
          }}
        />
      )}
      {view.name === "exam" && (
        <ExamPage
          setNo={view.setNo}
          activeAttempt={activeAttempts[view.setNo] ?? null}
          loadTest={loadTest}
          saveActive={saveActive}
          onExit={() => setView({ name: "home" })}
          onSubmit={submitAttempt}
        />
      )}
      {view.name === "result" && (
        <ResultPage
          attempt={getAttemptForResult(view.attemptId)}
          onHome={() => setView({ name: "home" })}
          onRetake={(setNo) => setView({ name: "confirm", setNo })}
          onReview={(attemptId) => setView({ name: "review", attemptId })}
        />
      )}
      {view.name === "review" && (
        <ReviewPage
          attempt={history.find((attempt) => attempt.id === view.attemptId)}
          loadTest={loadTest}
          onHome={() => setView({ name: "home" })}
          onRetake={(setNo) => setView({ name: "confirm", setNo })}
        />
      )}
      {view.name === "practice" && (
        <PracticePage
          progress={practiceProgress}
          loadAllQuestions={loadAllQuestions}
          saveProgress={savePracticeProgress}
          onHome={() => setView({ name: "home" })}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <main>{children}</main>
    </div>
  );
}

function HomePage({
  testIndex,
  history,
  activeAttempts,
  practiceProgress,
  onStart,
  onResume,
  onReview,
  onPractice,
}: {
  testIndex: TestIndexItem[];
  history: CompletedAttempt[];
  activeAttempts: Record<number, ActiveAttempt | null>;
  practiceProgress: PracticeProgress;
  onStart: (setNo: number) => void;
  onResume: (setNo: number) => void;
  onReview: (attemptId: string) => void;
  onPractice: (mode: PracticeMode) => void;
}) {
  const totalPracticeQuestions = testIndex.reduce((total, test) => total + test.questionCount, 0);
  const practiceStats = getPracticeStats(practiceProgress, totalPracticeQuestions);

  return (
    <div className="page home-page">
      <header className="hero">
        <p className="eyebrow">Singapore Final Theory Test</p>
        <h1>FTT Practice</h1>
        <p>Choose one of the 10 full test sets. Attempts, results, and unfinished tests are saved on this device.</p>
      </header>

      <section className="practice-home-panel" aria-label="Practice mode">
        <div>
          <p className="eyebrow">Revision mode</p>
          <h2>Practice All Questions</h2>
          <p>Endless, untimed revision across all {totalPracticeQuestions} questions with instant answer feedback.</p>
        </div>
        <dl className="practice-stats">
          <div>
            <dt>Practised</dt>
            <dd>{practiceStats.attempted}/{totalPracticeQuestions}</dd>
          </div>
          <div>
            <dt>Accuracy</dt>
            <dd>{practiceStats.attempted ? `${practiceStats.accuracy}%` : "No answers yet"}</dd>
          </div>
          <div>
            <dt>Needs practice</dt>
            <dd>{practiceStats.needsPractice}</dd>
          </div>
        </dl>
        <div className="practice-actions">
          <button onClick={() => onPractice("all")}>
            {practiceStats.attempted ? "Continue Practice" : "Start Practice"}
          </button>
          <button className="secondary" disabled={practiceStats.needsPractice === 0} onClick={() => onPractice("mistakes")}>
            Practice Mistakes
          </button>
        </div>
      </section>

      <section className="test-grid" aria-label="Test sets">
        {testIndex.map((test) => {
          const attempts = history.filter((attempt) => attempt.testSet === test.setNo);
          const best = attempts.length ? Math.max(...attempts.map((attempt) => attempt.score)) : null;
          const last = attempts[0];
          const active = activeAttempts[test.setNo];

          return (
            <article className="test-card" key={test.setNo}>
              <div>
                <p className="card-kicker">Set {test.setNo}</p>
                <h2>{test.title}</h2>
              </div>
              <dl className="stats">
                <div>
                  <dt>Best score</dt>
                  <dd>{best === null ? "No attempts" : `${best}/50`}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{attempts.length}</dd>
                </div>
                <div>
                  <dt>Last attempted</dt>
                  <dd>{last ? formatDate(last.completedAt) : "Never"}</dd>
                </div>
              </dl>
              {active && (
                <div className="active-note">
                  <strong>Unfinished attempt</strong>
                  <span>{formatDuration(getRemainingSeconds(active))} remaining</span>
                </div>
              )}
              <div className="card-actions">
                {active && <button className="secondary" onClick={() => onResume(test.setNo)}>Resume</button>}
                <button onClick={() => onStart(test.setNo)}>{active ? "Restart / Details" : "Start Test"}</button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="history-section">
        <div className="section-heading">
          <h2>Attempt History</h2>
          <p>Stored locally on this device.</p>
        </div>
        {history.length === 0 ? (
          <div className="empty-panel">Completed attempts will appear here.</div>
        ) : (
          <div className="history-list">
            {history.map((attempt) => (
              <article className="history-row" key={attempt.id}>
                <div>
                  <strong>{attempt.testTitle}</strong>
                  <span>{formatDate(attempt.completedAt)}</span>
                </div>
                <div className={attempt.passed ? "pill pass" : "pill fail"}>{attempt.passed ? "Pass" : "Fail"}</div>
                <div>{attempt.score}/50</div>
                <div>{formatDuration(attempt.timeTakenSeconds)}</div>
          <button className="secondary icon-review" onClick={() => onReview(attempt.id)}>Review</button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StartConfirmation({
  setNo,
  testIndex,
  activeAttempt,
  onBack,
  onResume,
  onStart,
}: {
  setNo: number;
  testIndex: TestIndexItem[];
  activeAttempt: ActiveAttempt | null;
  onBack: () => void;
  onResume: () => void;
  onStart: (shuffle: boolean) => void;
}) {
  const [shuffle, setShuffle] = useState(false);
  const test = testIndex.find((item) => item.setNo === setNo);

  return (
    <div className="page narrow-page">
      <button className="text-button" onClick={onBack}>Back to home</button>
      <section className="panel">
        <p className="eyebrow">Start confirmation</p>
        <h1>{test?.title ?? `FTT Test ${setNo}`}</h1>
        <ul className="rule-list">
          <li>50 questions</li>
          <li>50-minute time limit</li>
          <li>Pass mark is 45/50</li>
          <li>Answers can be changed before submission</li>
          <li>Manual submit requires all 50 questions answered</li>
          <li>If time runs out, the test auto-submits</li>
          <li>Unanswered questions are marked incorrect</li>
        </ul>

        <label className="toggle-line">
          <input type="checkbox" checked={shuffle} onChange={(event) => setShuffle(event.target.checked)} />
          <span>
            <strong>Shuffle question order</strong>
            <small>Original order is used by default. Options stay in A/B/C order.</small>
          </span>
        </label>

        {activeAttempt && (
          <div className="resume-panel">
            <strong>You have an unfinished attempt for this set.</strong>
            <span>Timer continues from the original start time. Remaining: {formatDuration(getRemainingSeconds(activeAttempt))}</span>
        <button className="secondary" onClick={onResume}>Resume unfinished test</button>
          </div>
        )}

        <div className="form-actions">
          <button className="secondary" onClick={onBack}>Cancel</button>
          <button
            onClick={() => {
              if (activeAttempt && !window.confirm("Restart this test and replace the unfinished attempt?")) return;
              onStart(shuffle);
            }}
          >
            {activeAttempt ? "Restart Test" : "Start Test"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ExamPage({
  setNo,
  activeAttempt,
  loadTest,
  saveActive,
  onExit,
  onSubmit,
}: {
  setNo: number;
  activeAttempt: ActiveAttempt | null;
  loadTest: (setNo: number) => Promise<TestSet>;
  saveActive: (attempt: ActiveAttempt | null, setNo: number) => void;
  onExit: () => void;
  onSubmit: (attempt: ActiveAttempt, submittedBy: "manual" | "timer") => Promise<CompletedAttempt>;
}) {
  const [test, setTest] = useState<TestSet | null>(null);
  const [currentNo, setCurrentNo] = useState(activeAttempt?.currentQuestionNo ?? 1);
  const [remaining, setRemaining] = useState(activeAttempt ? getRemainingSeconds(activeAttempt) : DURATION_SECONDS);
  const [gridOpen, setGridOpen] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTest(setNo).then((loaded) => {
      if (!cancelled) setTest(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadTest, setNo]);

  useEffect(() => {
    if (!activeAttempt) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [activeAttempt]);

  useEffect(() => {
    if (!activeAttempt || submitting) return;
    const tick = window.setInterval(() => {
      const next = getRemainingSeconds(activeAttempt);
      setRemaining(next);
      if (next <= 0) {
        window.clearInterval(tick);
        setSubmitting(true);
        onSubmit(activeAttempt, "timer").catch(() => setSubmitting(false));
      }
    }, 500);
    return () => window.clearInterval(tick);
  }, [activeAttempt, onSubmit, submitting]);

  if (!activeAttempt) {
    return (
      <div className="page narrow-page">
        <section className="panel">
          <h1>No active test</h1>
          <p>This test has already been submitted or restarted.</p>
        <button className="icon-home" onClick={onExit}>Return Home</button>
        </section>
      </div>
    );
  }

  if (!test) {
    return <div className="center-state">Loading test...</div>;
  }

  const questionsByNo = new Map(test.questions.map((question) => [question.questionNo, question]));
  const currentIndex = Math.max(0, activeAttempt.order.indexOf(currentNo));
  const question = questionsByNo.get(currentNo) ?? test.questions[0];
  const selected = activeAttempt.answers[String(question.questionNo)];
  const answeredCount = Object.keys(activeAttempt.answers).length;
  const unanswered = activeAttempt.order.filter((questionNo) => !activeAttempt.answers[String(questionNo)]);
  const canSubmit = unanswered.length === 0;

  const updateAttempt = (updater: (attempt: ActiveAttempt) => ActiveAttempt) => {
    const next = updater(activeAttempt);
    saveActive(next, setNo);
  };

  const goToQuestion = (questionNo: number) => {
    setCurrentNo(questionNo);
    setGridOpen(false);
    updateAttempt((attempt) => ({ ...attempt, currentQuestionNo: questionNo }));
  };

  const goRelative = (offset: number) => {
    const nextIndex = Math.min(activeAttempt.order.length - 1, Math.max(0, currentIndex + offset));
    goToQuestion(activeAttempt.order[nextIndex]);
  };

  const submitManually = async () => {
    if (!canSubmit) return;
    if (!window.confirm("Submit your final answers? You cannot change them after submission.")) return;
    setSubmitting(true);
    try {
      await onSubmit(activeAttempt, "manual");
    } catch {
      setSubmitting(false);
    }
  };

  const source = mediaUrl(question);

  return (
    <div className="exam-page">
      <header className="exam-topbar">
        <button className="secondary compact icon-home" onClick={onExit}>Home</button>
        <div>
          <span>{test.title}</span>
          <strong>Question {currentIndex + 1} of {QUESTION_COUNT}</strong>
        </div>
        <div className={remaining < 300 ? "timer urgent" : "timer"}>{formatDuration(remaining)}</div>
        <button className="icon-submit" disabled={!canSubmit || submitting} onClick={submitManually}>
          Submit
        </button>
      </header>

      <div className="exam-layout">
        <QuestionGrid
          mode="exam"
          order={activeAttempt.order}
          currentNo={question.questionNo}
          answers={activeAttempt.answers}
          flags={activeAttempt.flags}
          onSelect={goToQuestion}
          open={gridOpen}
          onClose={() => setGridOpen(false)}
        />

        <section className="question-panel">
          <div className="mobile-grid-toggle">
            <button className="secondary" onClick={() => setGridOpen(true)}>Question grid</button>
            <span>{answeredCount}/50 answered</span>
          </div>

          <div className="question-copy">
            <p className="eyebrow">Question {question.questionNo}</p>
            <h1>{question.question}</h1>
            {source && (
              <button className="image-button" onClick={() => setMediaPreview(source)} aria-label="Open question image larger">
                <img src={source} alt={`Question ${question.questionNo} visual`} />
                <span>Tap to enlarge</span>
              </button>
            )}
          </div>

          <div className="options" role="radiogroup" aria-label="Answer options">
            {question.options.map((option) => (
              <button
                key={option.key}
                className={selected === option.key ? "option selected" : "option"}
                onClick={() =>
                  updateAttempt((attempt) => ({
                    ...attempt,
                    answers: { ...attempt.answers, [String(question.questionNo)]: option.key },
                  }))
                }
              >
                <span>{option.key}</span>
                <strong>{option.text}</strong>
              </button>
            ))}
          </div>

          <div className="exam-tools">
            <button
              className={activeAttempt.flags[String(question.questionNo)] ? "flag active icon-flag" : "flag icon-flag"}
              onClick={() =>
                updateAttempt((attempt) => ({
                  ...attempt,
                  flags: {
                    ...attempt.flags,
                    [String(question.questionNo)]: !attempt.flags[String(question.questionNo)],
                  },
                }))
              }
            >
              {activeAttempt.flags[String(question.questionNo)] ? "Unflag review" : "Flag for review"}
            </button>

            {!canSubmit && (
              <div className="unanswered-note">
                <span>{unanswered.length} unanswered. Manual submit unlocks after all questions are answered.</span>
                <button className="text-button" onClick={() => goToQuestion(unanswered[0])}>Go to first unanswered</button>
              </div>
            )}
          </div>
        </section>
      </div>

      <nav className="bottom-nav" aria-label="Question navigation">
        <button className="secondary icon-prev" disabled={currentIndex === 0} onClick={() => goRelative(-1)}>Previous</button>
        <button className="icon-next" disabled={currentIndex === activeAttempt.order.length - 1} onClick={() => goRelative(1)}>Next</button>
      </nav>

      {mediaPreview && (
        <div className="modal-backdrop" onClick={() => setMediaPreview(null)}>
          <div className="image-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <button className="close-button icon-close" onClick={() => setMediaPreview(null)}>Close</button>
            <img src={mediaPreview} alt="Question visual enlarged" />
          </div>
        </div>
      )}
    </div>
  );
}

function ResultPage({
  attempt,
  onHome,
  onRetake,
  onReview,
}: {
  attempt?: CompletedAttempt;
  onHome: () => void;
  onRetake: (setNo: number) => void;
  onReview: (attemptId: string) => void;
}) {
  if (!attempt) {
    return (
      <div className="page narrow-page">
        <section className="panel">
          <h1>Result unavailable</h1>
          <button onClick={onHome}>Return Home</button>
        </section>
      </div>
    );
  }

  return (
    <div className="page narrow-page">
      <section className="result-card">
        <p className="eyebrow">{attempt.testTitle}</p>
        <h1>{attempt.passed ? "Passed" : "Try Again"}</h1>
        <div className={attempt.passed ? "score-display pass" : "score-display fail"}>{attempt.score}/50</div>
        <p>{attempt.percentage}% · pass mark {PASS_MARK}/50</p>
        <dl className="result-list">
          <div><dt>Time taken</dt><dd>{formatDuration(attempt.timeTakenSeconds)}</dd></div>
          <div><dt>Questions answered</dt><dd>{attempt.questionsAnswered}/50</dd></div>
          <div><dt>Completed</dt><dd>{formatDate(attempt.completedAt)}</dd></div>
          <div><dt>Submitted by</dt><dd>{attempt.submittedBy === "timer" ? "Timer" : "Manual submit"}</dd></div>
          <div><dt>Question order</dt><dd>{attempt.shuffled ? "Shuffled" : "Original"}</dd></div>
        </dl>
        <div className="form-actions">
          <button className="secondary icon-review" onClick={() => onReview(attempt.id)}>Review Test</button>
          <button className="secondary" onClick={() => onRetake(attempt.testSet)}>Retake Test</button>
          <button className="icon-home" onClick={onHome}>Return Home</button>
        </div>
      </section>
    </div>
  );
}

function ReviewPage({
  attempt,
  loadTest,
  onHome,
  onRetake,
}: {
  attempt?: CompletedAttempt;
  loadTest: (setNo: number) => Promise<TestSet>;
  onHome: () => void;
  onRetake: (setNo: number) => void;
}) {
  const [test, setTest] = useState<TestSet | null>(null);
  const [currentNo, setCurrentNo] = useState(attempt?.order[0] ?? 1);
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [gridOpen, setGridOpen] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!attempt) return;
    let cancelled = false;
    loadTest(attempt.testSet).then((loaded) => {
      if (!cancelled) setTest(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, loadTest]);

  if (!attempt) {
    return (
      <div className="page narrow-page">
        <section className="panel">
          <h1>Attempt not found</h1>
          <button className="icon-home" onClick={onHome}>Return Home</button>
        </section>
      </div>
    );
  }

  if (!test) return <div className="center-state">Loading review...</div>;

  const questionsByNo = new Map(test.questions.map((question) => [question.questionNo, question]));
  const allQuestionNos = attempt.order;
  const questionNos = allQuestionNos.filter((questionNo) => {
    const question = questionsByNo.get(questionNo);
    const selected = attempt.answers[String(questionNo)];
    if (!question) return false;
    if (filter === "unanswered") return !selected;
    if (filter === "flagged") return Boolean(attempt.flags[String(questionNo)]);
    if (filter === "incorrect") return selected !== question.answer;
    return true;
  });
  const selectedQuestionNo = questionNos.includes(currentNo) ? currentNo : questionNos[0] ?? allQuestionNos[0];
  const question = questionsByNo.get(selectedQuestionNo) ?? test.questions[0];
  const selected = attempt.answers[String(question.questionNo)];
  const correct = selected === question.answer;
  const source = mediaUrl(question);

  return (
    <div className="exam-page review-page">
      <header className="exam-topbar">
        <button className="secondary compact icon-home" onClick={onHome}>Home</button>
        <div>
          <span>{attempt.testTitle}</span>
          <strong>Review mode</strong>
        </div>
        <div className={attempt.passed ? "pill pass" : "pill fail"}>{attempt.score}/50</div>
        <button onClick={() => onRetake(attempt.testSet)}>Retake</button>
      </header>

      <div className="exam-layout">
        <QuestionGrid
          mode="review"
          order={questionNos}
          currentNo={question.questionNo}
          answers={attempt.answers}
          flags={attempt.flags}
          questionsByNo={questionsByNo}
          onSelect={(questionNo) => {
            setCurrentNo(questionNo);
            setGridOpen(false);
          }}
          open={gridOpen}
          onClose={() => setGridOpen(false)}
        />

        <section className="question-panel">
          <div className="mobile-grid-toggle">
            <button className="secondary" onClick={() => setGridOpen(true)}>Question grid</button>
            <span>{questionNos.length} shown</span>
          </div>

          <div className="filters" role="group" aria-label="Review filters">
            {(["all", "incorrect", "unanswered", "flagged"] as ReviewFilter[]).map((item) => (
              <button
                key={item}
                className={filter === item ? "filter active" : "filter"}
                onClick={() => setFilter(item)}
              >
                {item === "all" ? "All questions" : item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>

          {questionNos.length === 0 ? (
            <div className="empty-panel">No questions match this filter.</div>
          ) : (
            <>
              <div className="question-copy">
                <p className="eyebrow">Question {question.questionNo}</p>
                <h1>{question.question}</h1>
                {source && (
                  <button className="image-button" onClick={() => setMediaPreview(source)}>
                    <img src={source} alt={`Question ${question.questionNo} visual`} />
                    <span>Tap to enlarge</span>
                  </button>
                )}
              </div>

              <div className="options review-options">
                {question.options.map((option) => {
                  const isUser = selected === option.key;
                  const isCorrect = question.answer === option.key;
                  return (
                    <div
                      className={[
                        "option",
                        isCorrect ? "correct" : "",
                        isUser && !isCorrect ? "wrong" : "",
                      ].join(" ")}
                      key={option.key}
                    >
                      <span>{option.key}</span>
                      <strong>{option.text}</strong>
                      {isCorrect && <em>Correct answer</em>}
                      {isUser && <em>Your answer</em>}
                    </div>
                  );
                })}
              </div>

              <div className={correct ? "review-verdict correct-text" : "review-verdict wrong-text"}>
                {selected ? (correct ? "Correct" : "Incorrect") : "Unanswered"}
                {attempt.flags[String(question.questionNo)] && " · Flagged"}
              </div>
            </>
          )}
        </section>
      </div>

      {mediaPreview && (
        <div className="modal-backdrop" onClick={() => setMediaPreview(null)}>
          <div className="image-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <button className="close-button icon-close" onClick={() => setMediaPreview(null)}>Close</button>
            <img src={mediaPreview} alt="Question visual enlarged" />
          </div>
        </div>
      )}
    </div>
  );
}

function PracticePage({
  progress,
  loadAllQuestions,
  saveProgress,
  onHome,
}: {
  progress: PracticeProgress;
  loadAllQuestions: () => Promise<Question[]>;
  saveProgress: (progress: PracticeProgress) => void;
  onHome: () => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAllQuestions()
      .then((loaded) => {
        if (cancelled) return;
        setQuestions(loaded);
        setLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Unable to load practice questions.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadAllQuestions]);

  const questionsById = useMemo(() => new Map(questions.map((question) => [question.id, question])), [questions]);
  const stats = useMemo(() => getPracticeStats(progress, questions.length), [progress, questions.length]);
  const currentQuestion = progress.currentQuestionId ? questionsById.get(progress.currentQuestionId) ?? null : null;
  const currentAnswer =
    currentQuestion && progress.currentAnswer?.questionId === currentQuestion.id ? progress.currentAnswer : null;

  useEffect(() => {
    if (questions.length === 0) return;

    const existingQuestion = progress.currentQuestionId ? questionsById.get(progress.currentQuestionId) ?? null : null;
    const canKeepExisting =
      Boolean(existingQuestion && currentAnswer) ||
      Boolean(existingQuestion && progress.mode === "all" && !progress.records[existingQuestion.id]) ||
      Boolean(existingQuestion && isNeedsPractice(existingQuestion, progress));

    if (canKeepExisting) return;

    const nextQuestion = pickQuestion(getPracticePool(questions, progress));
    if (!nextQuestion) return;

    saveProgress({
      ...progress,
      currentQuestionId: nextQuestion.id,
      currentAnswer: null,
    });
  }, [currentAnswer, progress, questions, questionsById, saveProgress]);

  const answerQuestion = (selected: OptionKey) => {
    if (!currentQuestion || currentAnswer) return;

    const now = Date.now();
    const previous = progress.records[currentQuestion.id];
    const correct = selected === currentQuestion.answer;
    saveProgress({
      ...progress,
      records: {
        ...progress.records,
        [currentQuestion.id]: {
          selected,
          correct,
          attempts: (previous?.attempts ?? 0) + 1,
          firstAnsweredAt: previous?.firstAnsweredAt ?? now,
          lastAnsweredAt: now,
          sourceSetNo: currentQuestion.setNo,
          questionNo: currentQuestion.questionNo,
        },
      },
      currentAnswer: {
        questionId: currentQuestion.id,
        selected,
        correct,
        answeredAt: now,
      },
    });
  };

  const goNext = () => {
    if (!currentQuestion) return;
    const nextQuestion = pickQuestion(getPracticePool(questions, progress), currentQuestion.id);
    saveProgress({
      ...progress,
      currentQuestionId: nextQuestion?.id ?? null,
      currentAnswer: null,
    });
  };

  const toggleFlag = () => {
    if (!currentQuestion) return;
    saveProgress({
      ...progress,
      flags: {
        ...progress.flags,
        [currentQuestion.id]: !progress.flags[currentQuestion.id],
      },
    });
  };

  const switchMode = (mode: PracticeMode) => {
    saveProgress({
      ...progress,
      mode,
      currentQuestionId: null,
      currentAnswer: null,
    });
  };

  const resetPractice = () => {
    if (!window.confirm("Reset all practice progress? This keeps test attempts and history unchanged.")) return;
    saveProgress(createEmptyPracticeProgress());
  };

  if (loading) return <div className="center-state">Loading practice questions...</div>;

  if (loadError) {
    return (
      <div className="page narrow-page">
        <section className="panel">
          <h1>Practice unavailable</h1>
          <p>{loadError}</p>
          <button className="icon-home" onClick={onHome}>Return Home</button>
        </section>
      </div>
    );
  }

  const source = currentQuestion ? mediaUrl(currentQuestion) : null;
  const hasPracticePool = getPracticePool(questions, progress).length > 0;

  return (
    <div className="exam-page practice-page">
      <header className="exam-topbar practice-topbar">
        <button className="secondary compact icon-home" onClick={onHome}>Home</button>
        <div>
          <span>{progress.mode === "mistakes" ? "Practice Mistakes" : "Practice All Questions"}</span>
          <strong>{stats.attempted}/{questions.length} practised</strong>
        </div>
        <div className="practice-mini-stats">
          <span>{stats.accuracy}% accuracy</span>
          <span>{stats.needsPractice} needs practice</span>
        </div>
      </header>

      <main className="practice-layout">
        <aside className="practice-side-panel">
          <div>
            <p className="eyebrow">Progress</p>
            <dl className="practice-side-stats">
              <div><dt>Remaining unseen</dt><dd>{stats.remaining}</dd></div>
              <div><dt>Correct latest</dt><dd>{stats.correct}</dd></div>
              <div><dt>Needs practice</dt><dd>{stats.needsPractice}</dd></div>
            </dl>
          </div>

          <div className="practice-mode-buttons" role="group" aria-label="Practice mode">
            <button
              className={progress.mode === "all" ? "filter active" : "filter"}
              onClick={() => switchMode("all")}
            >
              All questions
            </button>
            <button
              className={progress.mode === "mistakes" ? "filter active" : "filter"}
              disabled={stats.needsPractice === 0}
              onClick={() => switchMode("mistakes")}
            >
              Mistakes
            </button>
          </div>

          <button className="secondary" onClick={resetPractice}>Reset Practice Progress</button>
        </aside>

        <section className="question-panel practice-question-panel">
          {!currentQuestion || (!hasPracticePool && !currentAnswer) ? (
            <div className="practice-complete">
              <p className="eyebrow">Practice complete</p>
              <h1>{progress.mode === "mistakes" ? "No mistakes left to practise" : "All questions completed"}</h1>
              <p>
                {progress.mode === "mistakes"
                  ? "Wrong and flagged questions will appear here when they need another pass."
                  : "You have seen every question. Reset practice progress when you want to explicitly repeat the full bank."}
              </p>
              <div className="form-actions">
                {progress.mode === "mistakes" && <button onClick={() => switchMode("all")}>Back to All Questions</button>}
                <button className="secondary" onClick={resetPractice}>Practice All Again</button>
              </div>
            </div>
          ) : (
            <>
              <div className="practice-question-meta">
                <p className="eyebrow">Set {currentQuestion.setNo} · Question {currentQuestion.questionNo}</p>
                <button
                  className={progress.flags[currentQuestion.id] ? "flag active icon-flag" : "flag icon-flag"}
                  onClick={toggleFlag}
                >
                  {progress.flags[currentQuestion.id] ? "Marked difficult" : "Mark difficult"}
                </button>
              </div>

              <div className="question-copy">
                <h1>{currentQuestion.question}</h1>
                {source && (
                  <button className="image-button" onClick={() => setMediaPreview(source)} aria-label="Open question image larger">
                    <img src={source} alt={`Question ${currentQuestion.questionNo} visual`} />
                    <span>Tap to enlarge</span>
                  </button>
                )}
              </div>

              <div className="options practice-options" role="radiogroup" aria-label="Answer options">
                {currentQuestion.options.map((option) => {
                  const isSelected = currentAnswer?.selected === option.key;
                  const isCorrect = currentAnswer && currentQuestion.answer === option.key;
                  const isWrong = currentAnswer && isSelected && !isCorrect;
                  const classes = [
                    "option",
                    isSelected && !currentAnswer ? "selected" : "",
                    isCorrect ? "correct" : "",
                    isWrong ? "wrong" : "",
                  ].join(" ");

                  return (
                    <button
                      className={classes}
                      disabled={Boolean(currentAnswer)}
                      key={option.key}
                      onClick={() => answerQuestion(option.key)}
                    >
                      <span>{option.key}</span>
                      <strong>{option.text}</strong>
                      {isCorrect && <em>Correct answer</em>}
                      {isWrong && <em>Your answer</em>}
                    </button>
                  );
                })}
              </div>

              {currentAnswer && (
                <div className={currentAnswer.correct ? "practice-feedback correct-text" : "practice-feedback wrong-text"}>
                  <strong>{currentAnswer.correct ? "Correct" : "Incorrect"}</strong>
                  <span>
                    Correct answer: {currentQuestion.answer}.{" "}
                    {currentQuestion.options.find((option) => option.key === currentQuestion.answer)?.text}
                  </span>
                </div>
              )}

              <div className="practice-bottom-actions">
                <button className="secondary icon-home" onClick={onHome}>Exit Practice</button>
                <button className="icon-next" disabled={!currentAnswer} onClick={goNext}>Next Question</button>
              </div>
            </>
          )}
        </section>
      </main>

      {mediaPreview && (
        <div className="modal-backdrop" onClick={() => setMediaPreview(null)}>
          <div className="image-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <button className="close-button icon-close" onClick={() => setMediaPreview(null)}>Close</button>
            <img src={mediaPreview} alt="Question visual enlarged" />
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionGrid({
  mode,
  order,
  currentNo,
  answers,
  flags,
  questionsByNo,
  onSelect,
  open,
  onClose,
}: {
  mode: "exam" | "review";
  order: number[];
  currentNo: number;
  answers: Record<string, OptionKey>;
  flags: Record<string, boolean>;
  questionsByNo?: Map<number, Question>;
  onSelect: (questionNo: number) => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      <aside className={open ? "question-grid-panel open" : "question-grid-panel"}>
        <div className="grid-header">
          <strong>Question grid</strong>
          <button className="text-button mobile-only" onClick={onClose}>Close</button>
        </div>
        <div className="question-grid">
          {order.map((questionNo, index) => {
            const selected = answers[String(questionNo)];
            const flagged = flags[String(questionNo)];
            const question = questionsByNo?.get(questionNo);
            const isCorrect = question ? selected === question.answer : false;
            const classes = [
              "grid-cell",
              currentNo === questionNo ? "current" : "",
              selected ? "answered" : "unanswered",
              flagged ? "flagged" : "",
              mode === "review" && selected && isCorrect ? "correct" : "",
              mode === "review" && selected && !isCorrect ? "wrong" : "",
            ].join(" ");

            return (
              <button key={`${questionNo}-${index}`} className={classes} onClick={() => onSelect(questionNo)}>
                {index + 1}
              </button>
            );
          })}
        </div>
        <div className="legend">
          <span><i className="dot answered-dot" /> Answered</span>
          <span><i className="dot unanswered-dot" /> Unanswered</span>
          <span><i className="dot flag-dot" /> Flagged</span>
          {mode === "review" && <span><i className="dot wrong-dot" /> Incorrect</span>}
        </div>
      </aside>
      {open && <button className="drawer-backdrop" aria-label="Close question grid" onClick={onClose} />}
    </>
  );
}

export default App;
