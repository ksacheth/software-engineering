import { useParams } from 'react-router-dom';
import { Auth } from '@/components/auth/auth';
import { SiteFooter } from '@/components/layout/site-footer';

export function AuthPage() {
  const params = useParams();
  const rawPath = params['*']?.replace(/^\/+|\/+$/g, '') || '';
  const path = rawPath || 'sign-in';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md">
          <Auth path={path} />
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
