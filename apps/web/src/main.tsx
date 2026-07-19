import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { APP_TITLE } from './config/brand'
import './styles.css'

document.title = APP_TITLE
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
