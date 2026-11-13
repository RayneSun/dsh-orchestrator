import skeleton from '@fullcalendar/react/skeleton.css'
import palette from '@fullcalendar/react/themes/breezy/palettes/indigo.css'
import theme from '@fullcalendar/react/themes/breezy/theme.css'

/** CSS 由现有 adoptStyles 统一注入，避免插件运行时额外加载样式文件。 */
export const fullCalendarStyles = [skeleton, palette, theme].join('\n')
