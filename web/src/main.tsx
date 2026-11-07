import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import './styles.css';
import { queryClient } from './lib/api';
import App from './App';
import { installAiDevMock } from './ai/mock';

if (import.meta.env.DEV) installAiDevMock();

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
