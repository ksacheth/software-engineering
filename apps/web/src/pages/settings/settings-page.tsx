import { useParams } from 'react-router-dom';
import { Settings } from '@/components/auth/settings/settings';

export function SettingsPage() {
  const params = useParams();
  const rawPath = params['*']?.replace(/^\/+|\/+$/g, '') || '';
  const path = rawPath || 'account';

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Settings path={path} />
    </div>
  );
}
