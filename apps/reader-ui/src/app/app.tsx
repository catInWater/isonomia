import { Link, Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <main>
      <h1>Reader</h1>
      <nav aria-label="Main navigation">
        <Link to="/">Library</Link> · <Link to="/about">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<p>Your library is empty.</p>} />
        <Route
          path="/about"
          element={<p>Reader — built with React and Electron.</p>}
        />
        <Route
          path="*"
          element={
            <p>
              Page not found. <Link to="/">Return to library</Link>
            </p>
          }
        />
      </Routes>
    </main>
  );
}

export default App;
