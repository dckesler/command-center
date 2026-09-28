import { useRef, useState } from "react"
import { slugifyProjectName } from "../data/projects.ts"

const C = {
  header: "#93c5fd",
  dim: "#6b7280",
  key: "#a78bfa",
  value: "#e5e7eb",
  red: "#f87171",
}

export interface ProjectAnswers {
  name: string
  summary: string
  context: string
  epic: string | null
}

type StepId = keyof ProjectAnswers

interface Step {
  id: StepId
  title: string
  placeholder: string
  hint: string
  optional: boolean
  /** returns an error message, or null when the value is acceptable */
  validate?: (value: string) => string | null
}

const EPIC_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/

const STEPS: Step[] = [
  {
    id: "name",
    title: "New project 1/4 — name",
    placeholder: "short name, becomes the directory and tmux session (e.g. web-observability)",
    hint: "lowercase letters, digits, dots and hyphens; anything else is turned into hyphens",
    optional: false,
    validate: (v) => (slugifyProjectName(v) ? null : "name is empty after cleanup"),
  },
  {
    id: "summary",
    title: "New project 2/4 — summary",
    placeholder: "one or two sentences: what is this project for, what does done look like?",
    hint: "becomes the Goal section of PROJECT.md and the central agent's first briefing",
    optional: false,
  },
  {
    id: "context",
    title: "New project 3/4 — context (optional)",
    placeholder: "anything the agent should know: links, prior art, constraints, people, deadlines — enter to skip",
    hint: "becomes the Current state section; the central agent reads it before doing anything",
    optional: true,
  },
  {
    id: "epic",
    title: "New project 4/4 — Jira epic (optional)",
    placeholder: "epic key such as LW-17444 — enter to skip",
    hint: "linked in PROJECT.md; the project view shows the epic's status and ticket progress",
    optional: true,
    validate: (v) => (v === "" || EPIC_KEY.test(v) ? null : `"${v}" is not a Jira key (e.g. LW-17444)`),
  },
]

/**
 * Four-question interview for a new project: name, summary, context, epic.
 * Enter advances (empty enter skips optional steps); escape is handled by the
 * App and cancels the whole interview.
 */
export function ProjectInterview({ onSubmit }: { onSubmit: (answers: ProjectAnswers) => void }) {
  const [stepIndex, setStepIndex] = useState(0)
  const [answers, setAnswers] = useState<Partial<Record<StepId, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const draft = useRef("")
  const step = STEPS[stepIndex]

  const submit = () => {
    const value = draft.current.trim()
    if (!value && !step.optional) return
    const problem = step.validate?.(value) ?? null
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    const next = { ...answers, [step.id]: step.id === "name" ? slugifyProjectName(value) : step.id === "epic" ? value.toUpperCase() : value }
    draft.current = ""
    if (stepIndex + 1 < STEPS.length) {
      setAnswers(next)
      setStepIndex(stepIndex + 1)
      return
    }
    onSubmit({
      name: next.name ?? "",
      summary: next.summary ?? "",
      context: next.context ?? "",
      epic: next.epic ? next.epic : null,
    })
  }

  return (
    <box flexDirection="column">
      {STEPS.slice(0, stepIndex).map((done) => (
        <text key={done.id}>
          <span fg={C.dim}>{`  ${done.id.padEnd(8)} `}</span>
          <span fg={answers[done.id] ? C.value : C.dim}>{answers[done.id] || "(skipped)"}</span>
        </text>
      ))}
      <box title={step.title} border borderColor={error ? C.red : C.header} height={3} marginTop={stepIndex ? 1 : 0}>
        <input
          key={step.id}
          placeholder={step.placeholder}
          focused
          onInput={(value: string) => {
            draft.current = value
            if (error) setError(null)
          }}
          onSubmit={submit}
        />
      </box>
      <text fg={error ? C.red : C.dim}>{error ?? step.hint}</text>
      {stepIndex === STEPS.length - 1 && (
        <text fg={C.dim}>
          {"  "}enter on the last step creates the directory + PROJECT.md and starts the project session
        </text>
      )}
    </box>
  )
}
