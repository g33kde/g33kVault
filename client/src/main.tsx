import React from 'react';
import ReactDOM from 'react-dom/client';
import Host from './pages/Host';
import Upload from './pages/Upload';
import Booth from './pages/Booth';
import Slideshow from './pages/Slideshow';
import Admin from './pages/Admin';
import PhotoViewer from './pages/PhotoViewer';
import './styles/global.css';

function App() {
  switch (window.location.pathname) {
    case '/upload':
      return <Upload />;
    case '/booth':
      return <Booth />;
    case '/slideshow':
      return <Slideshow />;
    case '/admin':
      return <Admin />;
    case '/photo-viewer':
      return <PhotoViewer />;
    default:
      return <Host />;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
