import CRMMAngaer from "./crm-manager";
import MobileCRMManager from "./MobileCRMManager";
import { getStaffPage } from "@/lib/actions/users";
import { getCustomerPage } from "@/lib/actions/customers";

export default async function(){


    const [dataCustomers, dataUsers] = await Promise.all([getCustomerPage(), getStaffPage()]);

    return(
        <>
            <div className="hidden md:flex h-full w-full">
                <CRMMAngaer staff={dataUsers} customers={dataCustomers} />
            </div>

            <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden md:hidden">
                <MobileCRMManager staff={dataUsers} customers={dataCustomers} />
            </div>
        </>
    );
}
