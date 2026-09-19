import { startInternalAttendanceScheduler } from './internal-scheduler.js';

if(process.env.ATTENDANCE_DIRECT_ENABLED==='true'
  && process.env.ATTENDANCE_DIRECT_MODE==='live'
  && process.env.ATTENDANCE_DIRECT_INTERNAL_SCHEDULER_ENABLED==='true'){
  startInternalAttendanceScheduler();
  console.log('[attendance-direct/internal-scheduler] enabled');
}
