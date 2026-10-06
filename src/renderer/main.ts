import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "./foundation.css";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(React.createElement(App));
