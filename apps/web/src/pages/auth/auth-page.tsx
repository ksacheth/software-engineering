import { useParams } from 'react-router-dom';
import { Auth } from '@/components/auth/auth';

export function AuthPage() {
  const params = useParams();
  const rawPath = params['*']?.replace(/^\/+|\/+$/g, '') || '';
  const path = rawPath || 'sign-in';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <Auth path={path} />
      </div>
    </div>
  );
}
