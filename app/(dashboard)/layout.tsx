import Sidebar from '@/components/layout/sidebar';
import MobileNav from '@/components/layout/mobile-nav';
import Topbar from '@/components/layout/topbar';
import { auth } from '@/lib/auth';
import JornadaBanner from '@/components/layout/jornada-banner';
import AutoRefresh from '@/components/layout/auto-refresh';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {

  const session = await auth();
  const user = session?.user;
  const staffName = user?.name || "NONE";
  const role = user?.role || "NONE";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-gray-50 text-gray-900 lg:h-screen">
      <AutoRefresh />
      <Topbar userName={staffName} mobileJornada={<JornadaBanner role={user?.role} mobile />} />
      <JornadaBanner role={user?.role} />
      <main className="flex min-h-0 flex-1 w-full overflow-hidden">
        <Sidebar userRole={role} />

        <div className="flex-1 min-h-0 w-full mx-auto flex flex-col pb-16 lg:pb-0 overflow-y-auto">
          {children}
        </div>
      </main>

      <MobileNav userRole={role} />
    </div>
  );
}
