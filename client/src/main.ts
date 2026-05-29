import App from '@/App.vue'
import router from './router'
import { createApp } from 'vue'
// Global "futurism" pass — single stylesheet that retunes cards,
// buttons, chrome, scrollbars, focus rings, and chip silhouettes
// without touching individual components. Remove this line to revert.
import '@/styles/futurism.css'
import { AxiosError } from 'axios'
import { useSnackbar } from './shared/snackbar.composable'
import { getFileDropDirective } from './directives/file-upload.directive'
import { getDropPrinterPositionDirective } from './directives/printer-drop-position.directive'
import { VueQueryPlugin } from "@tanstack/vue-query";
import { createPinia } from "pinia";
import { vuetify } from "@/plugins/vuetify";

const app = createApp(App)

console.log(
  `[DEV: ${ import.meta.env.DEV }][PROD: ${ import.meta.env.PROD }]`,
  import.meta.env.PACKAGE_VERSION
)

app.config.errorHandler = (err: unknown) => {
  if (err instanceof AxiosError) {
    console.error(
      `An error was caught [${ err.name }]:\n ${ err.message }\n ${ err.config?.url }\n${ err.stack }`
    )

    // Check for common HTTP status codes and provide better messages
    let title = 'An error occurred'
    let subtitle = err.message
    const status = err.response?.status

    if (status === 500) {
      title = 'Server Error'
      subtitle = 'The server encountered an unexpected error. Please try again later.'
    } else if (status === 404) {
      title = 'Resource Not Found'
      subtitle = 'The requested resource could not be found.'
    } else if (status === 403) {
      title = 'Access Denied'
      subtitle = 'You do not have permission to access this resource.'
    } else if (status === 401) {
      title = 'Authentication Required'
      subtitle = 'Please log in to continue.'
    } else if (status && status >= 400 && status < 500) {
      title = 'Request Error'
      subtitle = 'There was a problem with your request. Please check and try again.'
    } else if (status && status >= 500) {
      title = 'Server Error'
      subtitle = 'The server is experiencing difficulties. Please try again later.'
    } else if (err.code === 'NETWORK_ERROR' || err.code === 'ECONNREFUSED') {
      title = 'Connection Error'
      subtitle = 'Unable to connect to the server. Please check your connection.'
    }

    useSnackbar().openErrorMessage({
      title,
      subtitle,
      timeout: 5000
    })
    return
  } else if (err instanceof Error) {
    console.error(
      `An error was caught [${ err.name }]:\n ${ err.message }\n ${ err.stack }`
    )
    useSnackbar().openErrorMessage({
      title: 'An error occurred',
      subtitle: err.message,
      timeout: 5000
    })
  } else {
    console.error('Unknown error caught:', err)
    useSnackbar().openErrorMessage({
      title: 'An error occurred',
      subtitle: 'An unexpected error occurred',
      timeout: 5000
    })
  }
}

app.directive('drop-upload', getFileDropDirective())
app.directive('drop-printer-position', getDropPrinterPositionDirective())

const pinia = createPinia();
app.use(pinia)

app.use(VueQueryPlugin)
app.use(vuetify)
app.use(router)
app.mount('#app')
