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

            <div className="flex md:hidden h-full w-full">
                <MobileCRMManager staff={dataUsers} customers={dataCustomers} />
            </div>
        </>
    );
}
