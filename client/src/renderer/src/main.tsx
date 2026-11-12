import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { createRoot } from "react-dom/client";
import { AccountProvider } from "./components/Account/Account";
import { App } from "./components/App/App";
import "./styles/global.css";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <DndProvider backend={HTML5Backend}>
      <AccountProvider>
        <App />
      </AccountProvider>
    </DndProvider>,
  );
