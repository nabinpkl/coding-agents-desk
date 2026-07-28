// Each entry declares its own stylesheets. `file-content.css` is the shared file-rendering sheet;
// `viewer.css` lays out this document and must never reach the IDE, which lays out its own.
import '../file-content.css'
import '../viewer.css'
import { installFileSurface } from './viewer.ts'

installFileSurface({ container: document.getElementById('content') })
