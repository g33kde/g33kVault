import React from 'react';
import ReactDOM from 'react-dom/client';
import Host from './pages/Host';
import Upload from './pages/Upload';
import Slideshow from './pages/Slideshow';
import Admin from './pages/Admin';
import './styles/global.css';

function App() {
  switch (window.location.pathname) {
    case '/upload':
      return <Upload />;
    case '/slideshow':
      return <Slideshow />;
    case '/admin':
      return <Admin />;
    default:
      return <Host />;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
