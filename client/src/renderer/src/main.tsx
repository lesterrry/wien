import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DndProvider backend={HTML5Backend}>
      <App />
    </DndProvider>,
  );
