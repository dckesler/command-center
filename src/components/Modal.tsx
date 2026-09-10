export interface ModalOption {
  label: string
  danger?: boolean
}

export interface ModalState {
  title: string
  /** Optional dim informational lines shown above the options. */
  body?: string[]
  options: ModalOption[]
  selected: number
  onPick: (index: number) => void
}

const C = {
  border: "#93c5fd",
  dim: "#6b7280",
  value: "#e5e7eb",
  danger: "#f87171",
  selectedBg: "#1f2937",
}

export function Modal({ modal }: { modal: ModalState }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={C.border}
      title={` ${modal.title} `}
      titleColor={C.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      alignSelf="flex-start"
      minWidth={60}
    >
      {modal.body?.map((line, i) => (
        <text key={`body-${i}`} fg={C.dim}>
          {line}
        </text>
      ))}
      {modal.options.map((option, i) => {
        const isSelected = i === modal.selected
        return (
          <box key={option.label} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : option.danger ? C.danger : C.value}>
                {isSelected ? "▸ " : "  "}
                {option.label}
              </span>
            </text>
          </box>
        )
      })}
      <text fg={C.dim}>j/k move   enter select   esc cancel</text>
    </box>
  )
}
