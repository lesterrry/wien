import { Library } from "lucide-react";
import { exampleDescriptions } from "../../../../shared/example-descriptions";
import { Dialog } from "../Dialog/Dialog";
import styles from "./ExamplePickerDialog.module.css";

export function ExamplePickerDialog({
  examples,
  onClose,
  onSelect,
}: {
  examples: string[];
  onClose: () => void;
  onSelect: (example: string) => void;
}) {
  return (
    <Dialog title="New from example" onClose={onClose}>
      <ul className={styles.exampleList} aria-label="Examples">
        {examples.map((example) => (
          <li key={example}>
            <button
              type="button"
              aria-label={example}
              aria-describedby={
                exampleDescriptions[example]
                  ? `example-${example}-description`
                  : undefined
              }
              onClick={() => onSelect(example)}
            >
              <Library size={16} />
              <span className={styles.exampleDetails}>
                <span>{example}</span>
                {exampleDescriptions[example] && (
                  <small id={`example-${example}-description`}>
                    {exampleDescriptions[example]}
                  </small>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
