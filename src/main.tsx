import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Workbench from './ui/Workbench';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('uniCAD: #root element is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);
