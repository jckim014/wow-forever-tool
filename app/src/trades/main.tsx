import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Trades } from './Trades'
import './trades.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Trades />
  </StrictMode>,
)
