import { useState } from "react";
import { createRoot } from "react-dom/client";
function App() {
  const [name, setName] = useState("Alex");
  return <main><h1>Settings</h1><label>Display name<input value={name} onChange={event => setName(event.target.value)} /></label><button onClick={() => alert("Saved")}>Save settings</button></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
